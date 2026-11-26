#!/usr/bin/env python3
"""E2E verification for issue #1 (Kayak dropdown indexing + LLM timeout).

Run:  DISPLAY=:99 ~/Workspace/env/server/bin/python3 tests/e2e.py
Requires: npm run build first, Xvfb on :99 (headless Chrome cannot load MV3
extensions), fixture + mock servers (started automatically).

The panel UI lives in a CLOSED shadow root (not reachable via selectors or
CDP DOM traversal), so the harness pins it open+snapped via the panel's own
sessionStorage persistence (`__ba_ui`) and drives it with coordinate clicks.
Act mode clicks on the page are intercepted by design, so the composer is
focused with a mousedown (focus happens before the act-mode capture handler
sees the click).

Scenarios:
  T0  settings wiring + budget-exhausting fixture
  T1  chat smoke (llm.ts streaming rewrite, chat path)
  T2a observe: portal dropdown reaches the index via "Recently appeared" (fix 1)
  T2b execute: clicking the fresh option row creates the chip (fix 1 e2e)
  T2c execute: type+submit observation carries post-submit field + chip text (fix 3)
  T3  full agent run on the mock Kayak page completes (loop + fixes together)
  T4a first-token timeout: two attempts -> friendly abort message (fix 2)
  T4b total-timeout: streaming past first token capped separately (fix 2)
  T4c configurable timeouts: larger first-token timeout lets a slow model through
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mock_llm import PLAIN_ANSWER  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.environ.get('BA_E2E_EXT', os.path.join(ROOT, '.output', 'chrome-mv3'))
FIXTURE_DIR = os.path.join(ROOT, 'tests', 'fixtures')
FIXTURE_URL = 'http://localhost:8901/kayak-like.html'
LLM_URL = 'http://localhost:8902'
USER_DATA = '/tmp/opencode/browser-agent-e2e-profile'

PASS, FAIL = [], []


def check(name, cond, detail=''):
    if cond:
        PASS.append(name)
        print(f'  PASS  {name}')
    else:
        FAIL.append(name)
        print(f'  FAIL  {name} {detail}')


def wait_port(url, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1)
            return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f'server not reachable: {url}')


def start_servers():
    procs = []
    procs.append(subprocess.Popen(
        [sys.executable, '-m', 'http.server', '8901', '--bind', '127.0.0.1'],
        cwd=FIXTURE_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    procs.append(subprocess.Popen(
        [sys.executable, os.path.join(ROOT, 'tests', 'mock_llm.py'), '8902'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    wait_port('http://127.0.0.1:8901/kayak-like.html')
    wait_port('http://127.0.0.1:8902/v1/models')
    return procs


def main():
    procs = start_servers()
    try:
        run_tests()
    finally:
        for proc in procs:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=5)
    print(f'\n{len(PASS)} passed, {len(FAIL)} failed')
    if FAIL:
        print('failed:', *FAIL, sep='\n  - ')
        sys.exit(1)


# ---------------------------------------------------------------- helpers

class Harness:
    def __init__(self, pw):
        self.pw = pw
        # The profile caches the unpacked extension's service-worker script
        # across launches (stale background code runs silently otherwise).
        shutil.rmtree(USER_DATA, ignore_errors=True)
        self.context = pw.chromium.launch_persistent_context(
            USER_DATA,
            headless=False,
            args=[
                f'--disable-extensions-except={EXT}',
                f'--load-extension={EXT}',
                '--no-sandbox',
                '--disable-dev-shm-usage',
            ],
        )
        # The panel restores snapped+open from sessionStorage on mount; preset it
        # before the content script runs so the composer sits at fixed coordinates.
        self.context.add_init_script(
            "try { sessionStorage.setItem('__ba_ui',"
            " JSON.stringify({ snapped: true, snapWidth: 380 })); } catch {}")
        self.sw = self.context.service_workers[0] if self.context.service_workers \
            else self.context.wait_for_event('serviceworker')
        self.sw_logs = []
        self.sw.on('console', lambda m: self.sw_logs.append(m.text))
        self.page_logs = []
        self.page = self.context.new_page()
        self.page.on('console', lambda m: self.page_logs.append(m.text))
        self.page.goto(FIXTURE_URL)
        self.page.wait_for_load_state('load')
        self.tab_id = self._tab_id()
        self.wait_ready()
        self.page.evaluate("""() => {
          window.__diag = { keys: [], inputs: 0, clicks: 0 };
          document.addEventListener('keydown', (e) => window.__diag.keys.push(e.key), true);
          document.addEventListener('input', () => window.__diag.inputs++, true);
          document.addEventListener('click', () => window.__diag.clicks++, true);
        }""")

    def _tab_id(self):
        return self.sw.evaluate(
            "async (url) => (await chrome.tabs.query({ url: url + '*' }))[0].id",
            FIXTURE_URL,
        )

    # -- settings ------------------------------------------------------
    def set_settings(self, **overrides):
        self.sw.evaluate(
            """async (overrides) => {
              const stored = await chrome.storage.local.get('settings');
              const settings = stored.settings || {};
              await chrome.storage.local.set({
                settings: { sites: {}, ...settings, ...overrides },
              });
            }""",
            overrides,
        )

    # -- rpc into the content script -----------------------------------
    def rpc(self, request):
        response = self.sw.evaluate(
            """async ([tabId, request]) => chrome.tabs.sendMessage(tabId, request)""",
            [self.tab_id, {'__rpc': True, 'request': request}],
        )
        if not response.get('ok'):
            raise RuntimeError(f"rpc {request.get('kind')} failed: {response.get('error')}")
        return response['data']

    def observe(self):
        return self.rpc({'kind': 'act:observe'})

    def wait_ready(self, timeout=10):
        """Wait until the content script answers RPCs (post-navigation race)."""
        deadline = time.time() + timeout
        last_error = None
        while time.time() < deadline:
            try:
                self.rpc({'kind': 'act:observe'})
                break
            except Exception as error:  # noqa: BLE001
                last_error = error
                time.sleep(0.25)
        else:
            raise RuntimeError(f'content script not ready: {last_error}')
        self.page.evaluate("""() => {
          window.__diag = { keys: [], inputs: 0, clicks: 0 };
          document.addEventListener('keydown', (e) => window.__diag.keys.push(e.key), true);
          document.addEventListener('input', () => window.__diag.inputs++, true);
          document.addEventListener('click', () => window.__diag.clicks++, true);
        }""")

    # -- agent state ----------------------------------------------------
    def agent_state(self):
        return self.sw.evaluate(
            "async (tabId) => (await chrome.storage.session.get('agent:' + tabId))['agent:' + tabId]",
            self.tab_id,
        )

    def clear_agent_state(self):
        self.sw.evaluate(
            "async (tabId) => chrome.storage.session.remove('agent:' + tabId)", self.tab_id)

    def wait_agent_started(self, goal, timeout=8):
        deadline = time.time() + timeout
        while time.time() < deadline:
            state = self.agent_state()
            if state and state.get('goal') == goal:
                return state
            time.sleep(0.2)
        self.page.screenshot(path='/tmp/opencode/agent-start-failure.png')
        diag = self.page.evaluate('window.__diag')
        raise RuntimeError(
            f'agent never started (composer focus broken?) — state={self.agent_state()} '
            f"url={self.page.url} "
            f"active={self.page.evaluate('document.activeElement?.id || document.activeElement?.tagName')} "
            f"keys={diag.get('keys', [])[-8:]} inputs={diag.get('inputs')} clicks={diag.get('clicks')}")

    def drain_confirms(self):
        """Auto-click any pending on-page confirm bar (destructive-mode gate).

        The spotlight publishes the confirm button's viewport center to
        sessionStorage['__ba_confirm'] while a confirmation is pending."""
        raw = self.page.evaluate("sessionStorage.getItem('__ba_confirm')")
        if not raw:
            return
        pos = json.loads(raw)
        self.page.mouse.click(pos['x'], pos['y'])
        time.sleep(0.2)

    def wait_agent_finished(self, timeout=60):
        deadline = time.time() + timeout
        state = None
        while time.time() < deadline:
            state = self.agent_state()
            if state and state.get('status') == 'finished':
                time.sleep(0.5)  # let the error/answer notification land
                return self.agent_state()
            self.drain_confirms()
            time.sleep(0.3)
        logs = ' | '.join(getattr(self, 'sw_logs', [])[-6:])
        raise TimeoutError(f'agent did not finish: {state}\nSW logs: {logs}')

    def wait_agent_paused(self, timeout=90):
        deadline = time.time() + timeout
        state = None
        while time.time() < deadline:
            state = self.agent_state()
            if state and state.get('status') == 'paused':
                time.sleep(0.5)  # let the paused notification land
                return self.agent_state()
            self.drain_confirms()
            time.sleep(0.3)
        logs = ' | '.join(getattr(self, 'sw_logs', [])[-6:])
        raise TimeoutError(f'agent did not pause: {state}\nSW logs: {logs}')

    def wait_agent_resumed(self, goal_fragment=None, timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            state = self.agent_state()
            if state and state.get('status') in ('running', 'finished'):
                narration = '\n'.join(state.get('narration', []))
                goal_ok = goal_fragment is None or goal_fragment in state.get('goal', '')
                if goal_ok and 'Resumed by user' in narration:
                    time.sleep(0.2)
                    return self.agent_state()
            time.sleep(0.2)
        raise TimeoutError(f'agent did not resume: {self.agent_state()}')

    def chat_history(self):
        return self.sw.evaluate(
            "async (tabId) => (await chrome.storage.session.get('chat:' + tabId))['chat:' + tabId]",
            self.tab_id,
        ) or []

    # -- panel UI (closed shadow DOM -> coordinate clicks) ---------------
    def enable_act(self):
        vw = self.page.evaluate('window.innerWidth')
        for dx in (146, 152, 140, 156, 136, 162):
            self.page.mouse.click(vw - dx, 21)
            time.sleep(0.2)
            if self.page.evaluate("document.body.style.cursor") == 'crosshair':
                return
        raise RuntimeError('could not enable Act mode (probed all header positions)')

    def focus_composer(self):
        """Focus the composer with a mousedown: focus is applied before the
        act-mode capture click handler intercepts the (subsequent) click."""
        vw = self.page.evaluate('window.innerWidth')
        vh = self.page.evaluate('window.innerHeight')
        self.page.mouse.move(vw - 184, vh - 28)
        self.page.mouse.down()
        self.page.mouse.up()
        time.sleep(0.1)

    def send_text(self, text):
        self.focus_composer()
        self.page.keyboard.type(text)
        self.page.keyboard.press('Enter')

    def disable_act(self):
        self.page.keyboard.press('Escape')  # unpin if pinned
        time.sleep(0.1)
        if self.page.evaluate("document.body.style.cursor") == 'crosshair':
            self.page.keyboard.press('Escape')  # exit act mode
        time.sleep(0.1)


# ---------------------------------------------------------------- tests

def run_tests():
    with sync_playwright() as pw:
        h = Harness(pw)
        try:
            t0_wiring(h)
            t1_chat_smoke(h)
            t2_indexer_and_post_submit(h)
            t3_full_agent_run(h)
            t4_timeouts(h)
            t5_batch_stop_on_navigation(h)
            t6_working_memory(h)
            t7_memory_flag_off(h)
            t8_answer_fallback(h)
            t9_panel_reconnect(h)
            t10_endpoint_tts(h)
            t11_tts_pipeline(h)
            t12_key_op_and_persistent_ids(h)
            t13_destructive_submit_gate(h)
            t14_perception_fidelity(h)
            t15_reasoning_ops(h)
            t16_loop_control(h)
            t17_vision_look(h)
        finally:
            h.context.close()


def t0_wiring(h):
    print('\nT0: extension + settings wiring')
    h.set_settings(
        endpointUrl=LLM_URL, model='scripted', apiKey='',
        actEndpointUrl='', actModel='', actReasoningEffort='',
    )
    settings = h.sw.evaluate("async () => (await chrome.storage.local.get('settings')).settings")
    check('t0 settings persisted', settings and settings.get('endpointUrl') == LLM_URL, str(settings))
    index = h.observe()
    check('t0 observe returns index', len(index['index']) > 1000)
    check('t0 budget-exhausting page', 'more elements not shown' in index['index'],
          'expected truncation note (page must exceed the 320 budget)')


def t1_chat_smoke(h):
    print('\nT1: chat smoke over rewritten llm streaming')
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    h.send_text('Say OK.')
    deadline = time.time() + 20
    reply = ''
    while time.time() < deadline and not reply:
        time.sleep(0.3)
        history = h.sw.evaluate(
            "async (tabId) => (await chrome.storage.session.get('chat:' + tabId))['chat:' + tabId]",
            h.tab_id,
        ) or []
        assistants = [m['text'] for m in history if m.get('role') == 'assistant']
        reply = assistants[-1] if assistants else ''
    check('t1 chat reply streamed', len(reply) > 10, repr(reply[:80]))


def t2_indexer_and_post_submit(h):
    print('\nT2: indexer freshness pinning + post-submit observation')
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)
    h.enable_act()
    base = h.observe()
    check('t2 origin field indexed before typing', 'combobox "Origin"' in base['index'])
    check('t2 dropdown absent before typing', 'New Delhi' not in base['index'])

    # programmatic fill (no click: act mode intercepts real clicks) triggers
    # the portal insertion via the input event -> childList mutation
    h.page.fill('#origin-group input', 'DEL')
    time.sleep(0.4)

    after = h.observe()
    check('t2 "Recently appeared" section present', 'Recently appeared' in after['index'],
          'fresh pinning header missing')
    check('t2 New Delhi option pinned into index', 'New Delhi' in after['index'])
    option_id = None
    for line in after['index'].splitlines():
        if 'New Delhi' in line:
            option_id = int(line.split(']')[0].strip('['))
            break
    check('t2 option row has an id', option_id is not None)
    if option_id is not None:
        static_ids = [
            int(line.split(']')[0].strip('['))
            for line in after['index'].splitlines()
            if line.startswith('[') and 'Deal to City' in line
        ]
        check('t2 option id beyond static budget (portal at body end)',
              bool(static_ids) and option_id > max(static_ids),
              f'option {option_id} vs max deal {max(static_ids) if static_ids else None}')

    # execute a click on the fresh option -> chip must appear on the page
    observations = h.rpc({'kind': 'act:execute',
                          'actions': [{'op': 'click', 'target': option_id}],
                          'confirmMode': 'never'})
    check('t2 click option ok', observations[0]['ok'], str(observations[0]))
    chip_text = h.page.evaluate("document.querySelector('#origin-group .chip')?.textContent || ''")
    check('t2 chip created on page', 'New Delhi (DEL)' in chip_text, repr(chip_text))
    # the origin commit blurred its input, whose blur handler closes the shared
    # portal 150ms later - let that settle before opening the dest dropdown
    time.sleep(0.4)

    # fix 3: type+submit observation includes post-submit state + nearby chip.
    # First open the destination dropdown (type + wait in one batch), then a
    # type+submit commits the top suggestion like the issue's blind-Enter flow.
    dest_id = None
    for line in after['index'].splitlines():
        if 'combobox "Destination"' in line:
            dest_id = int(line.split(']')[0].strip('['))
            break
    check('t2 destination field indexed', dest_id is not None)
    h.rpc({'kind': 'act:execute',
           'actions': [{'op': 'type', 'target': dest_id, 'text': 'SFO'},
                       {'op': 'wait', 'ms': 400}],
           'confirmMode': 'never'})
    obs = h.rpc({'kind': 'act:execute',
                 'actions': [{'op': 'type', 'target': dest_id, 'text': 'SFO', 'submit': True}],
                 'confirmMode': 'never'})[0]
    check('t2 submit ok', obs.get('ok'), str(obs))
    message = obs.get('message', '')
    check('t2 observation reports submit', '+ submit' in message, message)
    check('t2 observation has post-submit section', '[post-submit:' in message, message)
    check('t2 post-submit mentions chip text', 'San Francisco (SFO)' in message, message)
    chip2 = h.page.evaluate("document.querySelector('#dest-group .chip')?.textContent || ''")
    check('t2 destination chip on page', 'San Francisco (SFO)' in chip2, repr(chip2))
    h.disable_act()


def t3_full_agent_run(h):
    print('\nT3: full agent run on mock Kayak page (scripted model)')
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)
    goal = 'Search for flights from DEL to SFO for Dec 24'
    h.enable_act()
    h.clear_agent_state()
    h.send_text(goal)
    h.wait_agent_started(goal)
    state = h.wait_agent_finished(timeout=60)
    narration = '\n'.join(state.get('narration', []))
    check('t3 run finished without error', 'Error' not in narration, narration[-300:])
    check('t3 agent used dropdown option (not blind submit)',
          'click' in narration and 'New Delhi' in narration, narration[:400])
    check('t3 post-submit verification visible in narration',
          '[post-submit:' in narration, narration[:600])
    check('t3 no "value did not stick" failures', 'did not stick' not in narration)
    results = h.page.evaluate("document.querySelector('#results')?.textContent || ''")
    check('t3 results shown on page', '8 flights found' in results, repr(results))
    check('t3 summary mentions flights', 'flights' in (state.get('narration')[-1] or '').lower(),
          state.get('narration', ['-'])[-1])
    answer = wait_chat_answer(h, timeout=20)
    check('t3 synthesized answer landed in chat history', answer is not None,
          'no assistant answer after the run')
    h.disable_act()


def wait_chat_answer(h, timeout=20, contains=None):
    """Poll the tab's chat history for the last assistant message (the
    synthesized answer). Returns it, or None on timeout."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        history = h.sw.evaluate(
            "async (tabId) => (await chrome.storage.session.get('chat:' + tabId))['chat:' + tabId]",
            h.tab_id,
        ) or []
        assistants = [m['text'] for m in history if m.get('role') == 'assistant']
        last = assistants[-1] if assistants else None
        if last and (contains is None or contains in last):
            return last
        time.sleep(0.4)
    return last


def t5_batch_stop_on_navigation(h):
    print('\nT5: action batches stop-and-report when the page starts navigating')
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)
    h.enable_act()
    base = h.observe()
    link_id = None
    for line in base['index'].splitlines():
        if 'Deal to City 3' in line:
            link_id = int(line.split(']')[0].strip('['))
            break
    check('t5 deal link indexed', link_id is not None)
    obs = h.rpc({'kind': 'act:execute',
                 'actions': [{'op': 'click', 'target': link_id},
                             {'op': 'wait', 'ms': 2000},
                             {'op': 'extract'}],
                 'confirmMode': 'never'})
    check('t5 anchor click ok', obs[0]['ok'], str(obs[0]))
    check('t5 wait after anchor click skipped',
          len(obs) == 3 and not obs[1]['ok'] and 'skipped' in (obs[1]['message'] or ''), str(obs[1]))
    check('t5 extract after anchor click skipped',
          not obs[2]['ok'] and 'skipped' in (obs[2]['message'] or ''), str(obs[2]))
    # navigate + wait: the response must escape before the deferred navigation
    obs2 = h.rpc({'kind': 'act:execute',
                  'actions': [{'op': 'navigate', 'url': FIXTURE_URL + '?nav=1'},
                              {'op': 'wait', 'ms': 2000}],
                  'confirmMode': 'never'})
    check('t5 navigate ok', obs2[0]['ok'], str(obs2[0]))
    check('t5 wait after navigate skipped',
          not obs2[1]['ok'] and 'skipped' in (obs2[1]['message'] or ''), str(obs2[1]))
    time.sleep(1)
    h.wait_ready()


MOCK_DEBUG = 'http://127.0.0.1:8902'


def t6_working_memory(h):
    print('\nT6: working memory + self-managed effort (flag ON)')
    goal = 'Search for flights from DEL to SFO for Dec 24'
    h.set_settings(model='memsched', actReasoningEffort='high', agentWorkingMemory=True)
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)
    h.enable_act()
    h.clear_agent_state()
    h.send_text(goal)
    h.wait_agent_started(goal)
    state = h.wait_agent_finished(timeout=90)
    narration = '\n'.join(state.get('narration', []))
    check('t6 run finished without error', 'Error' not in narration, narration[-300:])
    check('t6 settings effort used on step 1 (fallback)', 'recv_eff=high' in narration,
          narration[:500])
    check('t6 memory injected + effort forwarded on step 2',
          'recv_mem=MEM-A tail=N over=N recv_eff=medium' in narration, narration[:700])
    check('t6 rewritten memory carried to step 3',
          'recv_mem=MEM-B tail=N over=N recv_eff=low' in narration, narration[:900])
    check('t6 long memory truncated + junk effort ignored',
          'tail=Y over=N recv_eff=low' in narration, narration)
    check('t6 overflow marker absent', 'TRUNC-OVERFLOW' not in narration)
    check('t6 effort off disables thinking on the next call',
          'recv_mem=MEM-C tail=N over=N recv_eff=off' in narration, narration)
    results = h.page.evaluate("document.querySelector('#results')?.textContent || ''")
    check('t6 run completed the search', '8 flights found' in results, repr(results))
    h.disable_act()


def t7_memory_flag_off(h):
    print('\nT7: working memory flag OFF -> classic behavior')
    goal = 'Search for flights from DEL to SFO for Dec 24'
    h.set_settings(model='scripted', actReasoningEffort='', agentWorkingMemory=False)
    urllib.request.urlopen(MOCK_DEBUG + '/debug/reset', timeout=5).read()
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)
    h.enable_act()
    h.clear_agent_state()
    h.send_text(goal)
    h.wait_agent_started(goal)
    state = h.wait_agent_finished(timeout=90)
    narration = '\n'.join(state.get('narration', []))
    check('t7 run finished without error', 'Error' not in narration, narration[-400:])
    check('t7 no memory echoes in narration', 'recv_mem=' not in narration)
    records = json.load(urllib.request.urlopen(
        MOCK_DEBUG + '/debug/requests?model=scripted', timeout=5))
    steps = [record for record in records if record.get('step')]
    check('t7 step requests recorded', len(steps) >= 4,
          f'records={len(records)} narration_lines={len(state.get("narration", []))} '
          f'first={state.get("narration", ["-"])[0][:120]}')
    check('t7 no memory section in any prompt',
          all(not record['has_memory_section'] for record in steps))
    check('t7 no reasoning_effort sent', all(record['reasoning_effort'] is None for record in steps))
    check('t7 no thinking overrides sent',
          all(record['enable_thinking'] is None for record in steps))


def t8_answer_fallback(h):
    print('\nT8: answer delivery fallback when synthesis is too slow')
    goal = 'Search for flights from DEL to SFO for Dec 24'
    h.set_settings(model='synth-delay-8', actReasoningEffort='',
                   llmFirstTokenTimeoutMs=3000, agentWorkingMemory=False)
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)
    h.enable_act()
    h.clear_agent_state()
    h.send_text(goal)
    h.wait_agent_started(goal)
    state = h.wait_agent_finished(timeout=90)
    narration = '\n'.join(state.get('narration', []))
    check('t8 run finished without error', 'Error' not in narration, narration[-300:])
    answer = wait_chat_answer(h, timeout=30, contains='Flight search completed')
    check('t8 fallback summary delivered to chat after synthesis timeout',
          answer is not None, f'last assistant message: {answer!r}')
    # restore
    h.set_settings(model='scripted', llmFirstTokenTimeoutMs=None, llmTotalTimeoutMs=None)
    h.disable_act()


def t9_panel_reconnect(h):
    print('\nT9: notifications survive a mid-run navigation (eager panel port)')
    goal = 'Search for flights from DEL to SFO for Dec 24'
    h.set_settings(model='scripted', actReasoningEffort='', agentWorkingMemory=False,
                   llmFirstTokenTimeoutMs=None, llmTotalTimeoutMs=None)
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)
    h.enable_act()
    h.clear_agent_state()
    h.send_text(goal)
    h.wait_agent_started(goal)
    # navigate mid-run exactly like a real search flow would; the panel
    # remounts on the new page and must re-register its notification port
    h.page.goto(FIXTURE_URL + '?midrun=1')
    h.wait_ready()
    state = h.wait_agent_finished(timeout=120)
    narration = '\n'.join(state.get('narration', []))
    check('t9 run finished after mid-run navigation', 'Error' not in narration, narration[-300:])
    answer = wait_chat_answer(h, timeout=20, contains='Flight search completed')
    check('t9 answer delivered to chat after navigation', answer is not None, f'{answer!r}')
    dropped = [line for line in h.sw_logs if 'notification dropped' in line]
    check('t9 agent.done/chat.answer never dropped',
          all('agent.done' not in line and 'chat.answer' not in line for line in dropped),
          str(dropped[-3:]))


def t11_tts_pipeline(h):
    print('\nT11: chunked TTS pipeline (staged prefetch, play-on-arrival, natural pause)')
    h.set_settings(
        model='scripted', actReasoningEffort='', agentWorkingMemory=False,
        llmFirstTokenTimeoutMs=None, llmTotalTimeoutMs=None,
        ttsEndpointUrl=LLM_URL, ttsModel='kokoro', ttsVoice='slow-1.2', ttsAutoRead=True,
    )
    urllib.request.urlopen(MOCK_DEBUG + '/debug/reset', timeout=5).read()
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)
    h.send_text('Say OK.')
    records = wait_stable_tts_records(h, min_count=4, timeout=45, stable_secs=2.0)
    check('t11 multiple chunk requests served', len(records) >= 4, str(len(records)))
    if len(records) >= 3:
        recv = [r['received_t'] for r in records]
        check('t11 first chunk fires alone (batching servers keep TTFA)',
              recv[1] - recv[0] >= 0.7, f'gap {recv[1] - recv[0]:.2f}s')
        check('t11 no upfront burst: refills track pipeline progress',
              recv[2] - recv[0] >= 0.7 and recv[3] - recv[0] >= 0.7,
              f'recv offsets {[round(t - recv[0], 2) for t in recv]}')
        expected = re.sub(r'\s+', ' ', '{"answer": "' + PLAIN_ANSWER + '"}').strip()
        check('t11 chunks cover the full text in order',
              ordered_chunks(records, expected) == expected,
              f'got {len(ordered_chunks(records, expected))} chars, want {len(expected)}')
    h.set_settings(ttsVoice='af_heart', ttsAutoRead=False)


def wait_stable_tts_records(h, min_count=1, timeout=30, stable_secs=1.5):
    """Poll mock speech records until the count stops growing (the pipeline
    may still be mid-flight; concurrent refills also land in thread order)."""
    records = []
    last_count = -1
    changed_at = time.time()
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            records = json.load(urllib.request.urlopen(
                MOCK_DEBUG + '/debug/requests?model=tts', timeout=5))
        except Exception:
            records = []
        if len(records) >= min_count and len(records) == last_count \
                and time.time() - changed_at >= stable_secs:
            break
        if len(records) != last_count:
            last_count = len(records)
            changed_at = time.time()
        time.sleep(0.3)
    return records


def ordered_chunks(records, expected):
    """Records arrive in thread order; reorder middle chunks by their position
    in the expected text (the client's playback order is FIFO by design)."""
    if not records:
        return ''
    head = records[0].get('input') or ''
    middle = sorted(
        (r.get('input') or '' for r in records[1:]),
        key=lambda text: expected.find(text),
    )
    return ' '.join([head, *middle])


def t10_endpoint_tts(h):
    print('\nT10: endpoint TTS (voice:speak) + fallback to built-in speech')
    h.set_settings(
        model='scripted', actReasoningEffort='', agentWorkingMemory=False,
        llmFirstTokenTimeoutMs=None, llmTotalTimeoutMs=None,
        ttsEndpointUrl=LLM_URL, ttsModel='kokoro', ttsVoice='af_heart', ttsAutoRead=True,
    )
    urllib.request.urlopen(MOCK_DEBUG + '/debug/reset', timeout=5).read()
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)
    h.send_text('Say OK.')
    records = wait_stable_tts_records(h, min_count=3)
    check('t10 speech request reached the endpoint', bool(records), 'no /v1/audio/speech call')
    if records:
        first = records[0]
        check('t10 model+voice of preference sent',
              first.get('model') == 'kokoro' and first.get('voice') == 'af_heart', str(first))
        check('t10 first chunk is short (fast first word)',
              len(first.get('input') or '') <= 160 and 'Run completed' in (first.get('input') or ''),
              str(first))
        check('t10 long answer split into multiple chunks', len(records) >= 3, str(len(records)))
        check('t10 chunk sizes bounded', all(len(r.get('input') or '') <= 320 for r in records),
              str([len(r.get('input') or '') for r in records]))
        expected = re.sub(r'\s+', ' ', '{"answer": "' + PLAIN_ANSWER + '"}').strip()
        check('t10 chunks cover the full text in order',
              ordered_chunks(records, expected) == expected,
              f'got {len(ordered_chunks(records, expected))} chars, want {len(expected)}')

    # endpoint down -> built-in speech fallback, chat still works
    h.set_settings(ttsEndpointUrl='http://127.0.0.1:9999')
    h.send_text('Say OK again.')
    deadline = time.time() + 30
    warned = False
    grew = False
    while time.time() < deadline and not (warned and grew):
        warned = warned or any('TTS endpoint failed' in line for line in h.page_logs)
        history = h.sw.evaluate(
            "async (tabId) => (await chrome.storage.session.get('chat:' + tabId))['chat:' + tabId]",
            h.tab_id,
        ) or []
        grew = grew or len(history) >= 4
        time.sleep(0.4)
    check('t10 endpoint failure falls back with a warning', warned,
          'no fallback warning in page console')
    check('t10 second chat reply arrived', grew, 'history did not grow after the second send')
    h.set_settings(ttsEndpointUrl='', ttsAutoRead=False)


def t4_timeouts(h):
    print('\nT4: timeout semantics (fix 2)')
    goal = 'Search for flights from DEL to SFO for Dec 24'

    def run_goal():
        h.page.goto(FIXTURE_URL)
        h.page.wait_for_load_state('load')
        h.wait_ready()
        time.sleep(0.3)
        h.enable_act()
        h.clear_agent_state()
        h.send_text(goal)
        h.wait_agent_started(goal)
        state = h.wait_agent_finished(timeout=90)
        h.disable_act()
        return '\n'.join(state.get('narration', []))

    # T4a: first-token timeout x2 -> friendly abort, not "signal timed out"
    h.set_settings(model='delay-first-6', llmFirstTokenTimeoutMs=3000, llmTotalTimeoutMs=60000)
    narration = run_goal()
    check('t4a run aborted after double timeout', 'Error:' in narration, narration[-300:])
    check('t4a friendly timeout message', 'timed out twice in a row' in narration, narration[-300:])
    check('t4a first-token reason surfaced',
          'no response from the model within 3s' in narration, narration[-300:])
    check('t4a raw DOMException not surfaced', 'signal timed out' not in narration, narration[-300:])

    # T4b: total cap hits while tokens are streaming (first token was fast)
    h.set_settings(model='dribble-9', llmFirstTokenTimeoutMs=60000, llmTotalTimeoutMs=5000)
    narration = run_goal()
    check('t4b total-cap message', 'stream exceeded 5s in total' in narration, narration[-300:])
    check('t4b raw DOMException not surfaced', 'signal timed out' not in narration, narration[-300:])

    # T4c: configurable first-token timeout lets a 6s-slow model through
    h.set_settings(model='delay-first-6', llmFirstTokenTimeoutMs=8000, llmTotalTimeoutMs=60000)
    narration = run_goal()
    check('t4c slow first token survives with larger config', 'Error' not in narration,
          narration[-300:])
    check('t4c run completed', 'flights found' in h.page.evaluate(
        "document.querySelector('#results')?.textContent || ''"))

    # restore defaults for subsequent manual use of the profile
    h.set_settings(model='scripted', llmFirstTokenTimeoutMs=None, llmTotalTimeoutMs=None)


def id_of(index, needle):
    for line in index.splitlines():
        if needle in line and line.startswith('['):
            return int(line.split(']')[0].strip('['))
    return None


def t12_key_op_and_persistent_ids(h):
    print('\nT12: key op survives parse+execute; element ids persist across observations')
    h.set_settings(model='keytest', actReasoningEffort='', agentWorkingMemory=False,
                   llmFirstTokenTimeoutMs=None, llmTotalTimeoutMs=None)
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)

    before = h.observe()['index']
    origin_id = id_of(before, 'combobox "Origin"')
    check('t12 origin field indexed', origin_id is not None)
    h.rpc({'kind': 'act:execute', 'actions': [
        {'op': 'type', 'target': origin_id, 'text': 'DEL'},
        {'op': 'wait', 'ms': 400},
        {'op': 'type', 'target': origin_id, 'text': 'DEL', 'submit': True},
    ], 'confirmMode': 'never'})
    time.sleep(0.6)
    chip = h.page.evaluate("document.querySelector('#origin-group .chip')?.textContent || ''")
    check('t12 chip created by batch', 'New Delhi (DEL)' in chip, repr(chip))
    after = h.observe()['index']
    sid_before = id_of(before, '"Search flights"')
    sid_after = id_of(after, '"Search flights"')
    check('t12 element id persists across observations',
          sid_before is not None and sid_before == sid_after, f'{sid_before} vs {sid_after}')

    # fresh page: the keytest model presses Enter in Origin via the key op, then done
    h.page.goto(FIXTURE_URL + '?keytest=1')
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)
    h.enable_act()
    h.clear_agent_state()
    h.send_text('Press Enter in the origin field')
    h.wait_agent_started('Press Enter in the origin field')
    state = h.wait_agent_finished(timeout=60)
    narration = '\n'.join(state.get('narration', []))
    check('t12 key op executed', 'pressed Enter' in narration, narration[-300:])
    check('t12 key op not dropped by parser', 'no valid actions' not in narration, narration[-300:])
    check('t12 run finished with summary', 'KEYTEST COMPLETE' in narration, narration[-300:])
    h.disable_act()


def t13_destructive_submit_gate(h):
    print('\nT13: destructive mode gates type+submit; confirm works with Act mode off')
    h.set_settings(model='scripted', actReasoningEffort='', agentWorkingMemory=False,
                   llmFirstTokenTimeoutMs=None, llmTotalTimeoutMs=None)
    h.page.goto(FIXTURE_URL + '?gate=1')
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)
    index = h.observe()['index']
    dest_id = id_of(index, 'combobox "Destination"')
    check('t13 destination field indexed', dest_id is not None)

    # fire type+wait+type-submit with confirmMode 'destructive' WITHOUT answering
    h.sw.evaluate(
        """async ([tabId, request]) => {
             void chrome.tabs.sendMessage(tabId, {__rpc: true, request});
           }""",
        [h.tab_id, {'kind': 'act:execute', 'actions': [
            {'op': 'type', 'target': dest_id, 'text': 'SFO'},
            {'op': 'wait', 'ms': 400},
            {'op': 'type', 'target': dest_id, 'text': 'SFO', 'submit': True},
        ], 'confirmMode': 'destructive'}],
    )
    time.sleep(0.8)
    marker_raw = h.page.evaluate("sessionStorage.getItem('__ba_confirm')")
    check('t13 type+submit awaits confirmation', marker_raw is not None, str(marker_raw))
    if marker_raw:
        marker = json.loads(marker_raw)
        check('t13 confirmation says fill-and-submit', 'Fill and submit' in marker['text'],
              marker['text'])
        at_host = h.page.evaluate(
            "([x, y]) => document.elementFromPoint(x, y)?.id || ''", [marker['x'], marker['y']])
        check('t13 confirm bar is frontmost with Act mode off',
              at_host == 'browser-agent-act-root', at_host)
    value = h.page.evaluate("document.querySelector('#dest-group input')?.value || ''")
    chip = h.page.evaluate("document.querySelector('#dest-group .chip')?.textContent || ''")
    check('t13 submit not committed before confirmation', not chip, f'{value!r} {chip!r}')

    h.drain_confirms()
    time.sleep(1.2)
    chip2 = h.page.evaluate("document.querySelector('#dest-group .chip')?.textContent || ''")
    check('t13 confirmation lets the batch through', 'San Francisco (SFO)' in chip2, repr(chip2))
    check('t13 confirm marker cleared',
          h.page.evaluate("sessionStorage.getItem('__ba_confirm')") is None)


def t14_perception_fidelity(h):
    print('\nT14: R2 perception fidelity - live state, names, pointer-start, viewport order')
    h.set_settings(model='scripted', actReasoningEffort='', agentWorkingMemory=False,
                   llmFirstTokenTimeoutMs=None, llmTotalTimeoutMs=None)
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)
    index = h.observe()['index']

    def line_of(needle):
        for line in index.splitlines():
            if needle in line and line.startswith('['):
                return line
        return ''

    check('t14 label[for] name + live value state',
          'textbox "Departure time" = "morning"' in line_of('"Departure time"'),
          line_of('"Departure time"'))
    cabin = line_of('"Cabin class"')
    check('t14 select shows selected option + capped option list',
          'combobox "Cabin class" = "Economy"' in cabin and 'opts:' in cabin
          and 'Premium Economy' in cabin and 'First' in cabin, cabin)
    check('t14 wrapping label names the checkbox + [checked] flag',
          'checkbox "Nonstop only" [checked]' in line_of('"Nonstop only"'),
          line_of('"Nonstop only"'))
    check('t14 disabled field flagged',
          'textbox "Promo code" = "SUMMER20" [disabled]' in line_of('"Promo code"'),
          line_of('"Promo code"'))
    check('t14 unnamed checkbox borrows its row text (contextual name)',
          'checkbox "Window seat"' in index)
    check('t14 contextual name + disabled flag together',
          'checkbox "Extra legroom" [disabled]' in line_of('"Extra legroom"'),
          line_of('"Extra legroom"'))

    upgrade_lines = [l for l in index.splitlines()
                     if 'Seat upgrade offer' in l and l.startswith('[')]
    check('t14 pointer row indexed once (pointer starts at the row)',
          len(upgrade_lines) == 1, str(upgrade_lines))
    child_lines = [l for l in index.splitlines() if re.search(r'\] \w+ "\$25"', l)]
    check('t14 pointer-inherited child not indexed', not child_lines, str(child_lines))

    lines = index.splitlines()
    fab = next((i for i, l in enumerate(lines) if 'Help floating' in l), None)
    deal60 = next((i for i, l in enumerate(lines) if 'Deal to City 60' in l), None)
    check('t14 in-viewport interactive listed before offscreen ones',
          fab is not None and deal60 is not None and fab < deal60,
          f'fab={fab} deal60={deal60}')

    # live state follows the widget: typed value + aria-expanded on the index line
    h.page.fill('#origin-group input', 'DEL')
    time.sleep(0.4)
    after = h.observe()['index']
    origin_line = next((l for l in after.splitlines() if 'combobox "Origin"' in l), '')
    check('t14 typed value + [expanded] on the live line',
          '= "DEL"' in origin_line and '[expanded]' in origin_line, origin_line)
    h.page.evaluate("document.querySelector('#origin-group input')?.blur()")
    time.sleep(0.4)

    # extract on fields reports value / checked / selected
    dep_id = id_of(index, '"Departure time"')
    nonstop_id = id_of(index, '"Nonstop only"')
    cabin_id = id_of(index, '"Cabin class"')
    obs = h.rpc({'kind': 'act:execute', 'actions': [
        {'op': 'extract', 'target': dep_id},
        {'op': 'extract', 'target': nonstop_id},
        {'op': 'extract', 'target': cabin_id},
    ], 'confirmMode': 'never'})
    check('t14 extract reports field value',
          'value = "morning"' in (obs[0].get('message') or ''), str(obs[0]))
    check('t14 extract reports checkbox state',
          'is checked' in (obs[1].get('message') or ''), str(obs[1]))
    check('t14 extract reports selected option',
          'selected "Economy"' in (obs[2].get('message') or ''), str(obs[2]))


def t15_reasoning_ops(h):
    print('\nT15: R3 reasoning ops - select / find / inspect / focus')
    h.set_settings(model='scripted', actReasoningEffort='', agentWorkingMemory=False,
                   llmFirstTokenTimeoutMs=None, llmTotalTimeoutMs=None)
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)
    index = h.observe()['index']
    cabin_id = id_of(index, '"Cabin class"')
    dep_id = id_of(index, '"Departure time"')
    deal_id = id_of(index, 'Deal to City 1')
    check('t15 fields indexed', None not in (cabin_id, dep_id, deal_id))

    # select: pick by visible text; input/change events fire for framework listeners
    h.page.evaluate("""() => {
      window.__r3 = { changes: 0 };
      document.getElementById('cabin').addEventListener('change', () => window.__r3.changes++);
    }""")
    obs = h.rpc({'kind': 'act:execute',
                 'actions': [{'op': 'select', 'target': cabin_id, 'value': 'Business'}],
                 'confirmMode': 'never'})[0]
    check('t15 select ok', obs.get('ok'), str(obs))
    check('t15 select reports chosen option',
          'selected "Business"' in (obs.get('message') or ''), str(obs))
    check('t15 native select value changed',
          h.page.evaluate("document.querySelector('#cabin')?.value") == 'Business')
    check('t15 change event fired for framework listeners',
          h.page.evaluate('window.__r3.changes') == 1)

    # select failures: no such option / target holds no select
    obs = h.rpc({'kind': 'act:execute',
                 'actions': [{'op': 'select', 'target': cabin_id, 'value': 'Nonsense'}],
                 'confirmMode': 'never'})[0]
    check('t15 select with no match fails and lists options',
          not obs.get('ok') and 'Economy' in (obs.get('message') or ''), str(obs))
    obs = h.rpc({'kind': 'act:execute',
                 'actions': [{'op': 'select', 'target': deal_id, 'value': 'x'}],
                 'confirmMode': 'never'})[0]
    check('t15 select on a non-select target fails cleanly',
          not obs.get('ok') and 'holds no <select>' in (obs.get('message') or ''), str(obs))

    # find over the index: the contextually-named checkbox
    obs = h.rpc({'kind': 'act:execute', 'actions': [{'op': 'find', 'text': 'Window seat'}],
                 'confirmMode': 'never'})[0]
    check('t15 find locates an indexed element by name',
          obs.get('ok') and re.search(r'\[\d+\] checkbox "Window seat"', obs.get('message') or ''),
          str(obs))

    # find pass 2: a plain div the indexer skips is discovered, gets an id, keeps it
    obs = h.rpc({'kind': 'act:execute', 'actions': [{'op': 'find', 'text': 'Baggage fee'}],
                 'confirmMode': 'never'})[0]
    message = obs.get('message') or ''
    check('t15 find discovers a non-indexed element',
          obs.get('ok') and re.search(r'\[\d+\] div "Baggage fee', message), message)
    check('t15 find lists nearby controls for the discovered row',
          'controls:' in message and 'checkbox' in message, message)
    found = re.search(r'\[(\d+)\] div "Baggage fee', message)
    found_id = int(found.group(1)) if found else None
    if found_id is not None:
        after = h.observe()['index']
        check('t15 discovered element keeps its id in the next index',
              f'[{found_id}] div "Baggage fee' in after,
              '\n'.join(after.splitlines()[:8]))
        obs2 = h.rpc({'kind': 'act:execute', 'actions': [{'op': 'inspect', 'target': found_id}],
                      'confirmMode': 'never'})[0]
        detail = obs2.get('message') or ''
        check('t15 inspect reports text + position + surroundings',
              obs2.get('ok') and 'text: Baggage fee' in detail and 'position:' in detail
              and 'controls here:' in detail, detail)
    else:
        check('t15 discovered element keeps its id in the next index', False, message)
        check('t15 inspect reports text + position + surroundings', False, message)

    # inspect on an indexed select + dead id (the select's container holds no other
    # controls, so the state must show on the header line itself)
    obs = h.rpc({'kind': 'act:execute', 'actions': [{'op': 'inspect', 'target': cabin_id}],
                 'confirmMode': 'never'})[0]
    header = (obs.get('message') or '').splitlines()[0] if obs.get('message') else ''
    check('t15 inspect reports live state on the header line',
          obs.get('ok') and 'combobox "Cabin class" = "Business"' in header, str(obs))
    obs = h.rpc({'kind': 'act:execute', 'actions': [{'op': 'inspect', 'target': 99999}],
                 'confirmMode': 'never'})[0]
    check('t15 inspect on a dead id fails', not obs.get('ok'), str(obs))

    # focus
    obs = h.rpc({'kind': 'act:execute', 'actions': [{'op': 'focus', 'target': dep_id}],
                 'confirmMode': 'never'})[0]
    check('t15 focus ok', obs.get('ok'), str(obs))
    check('t15 field is focused',
          h.page.evaluate("document.activeElement?.id || ''") == 'dep-time')

    # find with no hits anywhere
    obs = h.rpc({'kind': 'act:execute', 'actions': [{'op': 'find', 'text': 'zzzqqq'}],
                 'confirmMode': 'never'})[0]
    check('t15 find with no hits fails with a hint',
          not obs.get('ok') and 'no element' in (obs.get('message') or ''), str(obs))

    # full agent run: select + focus survive parse (KNOWN_OPS) and execute
    goal = 'Pick Business cabin and focus the departure field'
    h.set_settings(model='r3select')
    h.enable_act()
    h.clear_agent_state()
    h.send_text(goal)
    h.wait_agent_started(goal)
    state = h.wait_agent_finished(timeout=60)
    narration = '\n'.join(state.get('narration', []))
    check('t15 select run finished without error', 'Error' not in narration, narration[-300:])
    check('t15 select op survived parse+execute', 'selected "Business"' in narration, narration)
    check('t15 focus op survived parse+execute', 'focused' in narration, narration)
    check('t15 select run done summary', 'R3SELECT COMPLETE' in narration, narration[-200:])
    check('t15 cabin now Business',
          h.page.evaluate("document.querySelector('#cabin')?.value") == 'Business')
    h.disable_act()

    # full agent run: find, then act on the discovered id in the next step.
    # Fresh document: the hint div is undiscovered again, so step 1 must run find.
    goal2 = 'Read the baggage fee hint'
    h.set_settings(model='r3find')
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)
    h.enable_act()
    h.clear_agent_state()
    h.send_text(goal2)
    h.wait_agent_started(goal2)
    state = h.wait_agent_finished(timeout=60)
    narration = '\n'.join(state.get('narration', []))
    check('t15 find run finished without error', 'Error' not in narration, narration[-300:])
    check('t15 find op ran in the agent loop', 'find \u2192 ok' in narration, narration)
    check('t15 inspect acted on the found id',
          'inspect' in narration and 'text: Baggage fee' in narration, narration)
    check('t15 find run done summary', 'R3FIND COMPLETE' in narration, narration[-200:])
    h.disable_act()


def t16_loop_control(h):
    print('\nT16: R4 loop control - blocked pause/resume, idle tolerance, step-cap pause, op cap, conversation feed')

    # --- blocked: the run pauses, the question reaches chat, next message resumes ---
    h.set_settings(model='r4blocked', actReasoningEffort='', agentWorkingMemory=False,
                   llmFirstTokenTimeoutMs=None, llmTotalTimeoutMs=None)
    urllib.request.urlopen(MOCK_DEBUG + '/debug/reset', timeout=5).read()
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)
    goal = 'Book a flight for me'
    h.enable_act()
    h.clear_agent_state()
    h.send_text(goal)
    h.wait_agent_started(goal)
    state = h.wait_agent_paused(timeout=60)
    check('t16 blocked pauses the run',
          state.get('status') == 'paused' and state.get('pausedReason') == 'blocked',
          str({k: state.get(k) for k in ('status', 'pausedReason')}))
    check('t16 pause question stored', 'Dec 24 or Dec 25' in (state.get('pauseQuestion') or ''),
          str(state.get('pauseQuestion')))
    history = h.chat_history()
    check('t16 question surfaced in chat history',
          any(m.get('role') == 'assistant' and 'Dec 24 or Dec 25' in m.get('text', '')
              for m in history), str(history[-2:]))
    records = json.load(urllib.request.urlopen(
        MOCK_DEBUG + '/debug/requests?model=r4blocked', timeout=5))
    check('t16 conversation fed into the plan prompt',
          any(r.get('step') and r.get('has_conversation') for r in records), str(records[-2:]))

    h.send_text('Dec 24 please')
    resumed = h.wait_agent_resumed(goal_fragment='Follow-up from the user: Dec 24 please')
    check('t16 next message resumes (task = union of messages)',
          resumed.get('status') in ('running', 'finished'), str(resumed.get('goal'))[:160])
    state = h.wait_agent_finished(timeout=60)
    narration = '\n'.join(state.get('narration', []))
    check('t16 resumed run finishes via status done', 'R4BLOCKED COMPLETE' in narration,
          narration[-300:])
    check('t16 resume message saved to chat history',
          any(m.get('role') == 'user' and m.get('text') == 'Dec 24 please'
              for m in h.chat_history()), str(h.chat_history()[-2:]))
    check('t16 status-done run finished cleanly', 'Error' not in narration, narration[-200:])
    h.disable_act()

    # --- idle steps: two tolerated, third aborts ---
    h.set_settings(model='r4idle')
    urllib.request.urlopen(MOCK_DEBUG + '/debug/reset', timeout=5).read()
    h.enable_act()
    h.clear_agent_state()
    goal2 = 'Idle then finish'
    h.send_text(goal2)
    h.wait_agent_started(goal2)
    state = h.wait_agent_finished(timeout=60)
    narration = '\n'.join(state.get('narration', []))
    check('t16 two idle steps tolerated', 'Error' not in narration, narration[-300:])
    check('t16 idle run finishes via status done', 'R4IDLE DONE' in narration, narration[-300:])

    h.set_settings(model='r4stall')
    h.clear_agent_state()
    goal3 = 'Never acts'
    h.send_text(goal3)
    h.wait_agent_started(goal3)
    state = h.wait_agent_finished(timeout=60)
    narration = '\n'.join(state.get('narration', []))
    check('t16 third consecutive idle step aborts',
          'no actions 3 steps in a row' in narration, narration[-300:])
    h.disable_act()

    # --- step cap: pause + continue (bare "continue" does not pollute the goal) ---
    h.set_settings(model='r4slow')
    h.clear_agent_state()
    goal4 = 'Grind forever'
    h.enable_act()
    h.send_text(goal4)
    h.wait_agent_started(goal4)
    state = h.wait_agent_paused(timeout=90)
    check('t16 step cap pauses instead of terminating',
          state.get('status') == 'paused' and state.get('pausedReason') == 'steplimit',
          str({k: state.get(k) for k in ('status', 'pausedReason', 'step')}))
    check('t16 step-cap question asks to continue',
          'continue' in (state.get('pauseQuestion') or ''), str(state.get('pauseQuestion')))
    h.set_settings(model='r4done')
    h.send_text('continue')
    h.wait_agent_resumed()
    state = h.wait_agent_finished(timeout=60)
    narration = '\n'.join(state.get('narration', []))
    check('t16 continue resumes with an extended budget',
          'R4CAP DONE' in narration and (state.get('maxSteps') or 0) > 12,
          f'maxSteps={state.get("maxSteps")} narration={narration[-200:]}')
    check('t16 bare "continue" not appended to the goal',
          'Follow-up' not in state.get('goal', ''), state.get('goal'))
    h.disable_act()

    # --- per-step op cap: 11 ops -> 8 run, 3 reported as dropped ---
    h.set_settings(model='r4cap')
    urllib.request.urlopen(MOCK_DEBUG + '/debug/reset', timeout=5).read()
    h.clear_agent_state()
    goal5 = 'Overload one step'
    h.enable_act()
    h.send_text(goal5)
    h.wait_agent_started(goal5)
    state = h.wait_agent_finished(timeout=60)
    narration = '\n'.join(state.get('narration', []))
    check('t16 ops beyond the per-step cap are dropped and reported',
          'beyond the 8-per-step cap' in narration and 'dropped 3 action(s)' in narration,
          narration[-400:])
    check('t16 op-cap run finished via status done', 'R4CAP COMPLETE' in narration,
          narration[-300:])
    h.disable_act()


def t17_vision_look(h):
    print('\nT17: R5 vision - look op captures a screenshot and feeds it to the next step')
    h.set_settings(model='r5look', actReasoningEffort='', agentWorkingMemory=False,
                   actVision=True, llmFirstTokenTimeoutMs=None, llmTotalTimeoutMs=None)
    urllib.request.urlopen(MOCK_DEBUG + '/debug/reset', timeout=5).read()
    h.page.goto(FIXTURE_URL)
    h.page.wait_for_load_state('load')
    h.wait_ready()
    time.sleep(0.3)

    # content-side guard: look executed directly (not via the loop) fails cleanly
    obs = h.rpc({'kind': 'act:execute', 'actions': [{'op': 'look'}], 'confirmMode': 'never'})[0]
    check('t17 look on the page side reports loop-handled',
          not obs.get('ok') and 'agent loop' in (obs.get('message') or ''), str(obs))

    # loop run with vision ON: look captures, the next step sees an image and finishes
    goal = 'Read the page visually'
    h.enable_act()
    h.clear_agent_state()
    h.send_text(goal)
    h.wait_agent_started(goal)
    state = h.wait_agent_finished(timeout=60)
    narration = '\n'.join(state.get('narration', []))
    check('t17 look captured a screenshot',
          'look' in narration and 'screenshot captured' in narration, narration[-300:])
    check('t17 vision run finished via status done', 'R5LOOK COMPLETE' in narration, narration[-200:])
    records = json.load(urllib.request.urlopen(
        MOCK_DEBUG + '/debug/requests?model=r5look', timeout=5))
    steps = [r for r in records if r.get('step')]
    check('t17 screenshot attached to a later step',
          any(r.get('has_image') for r in steps), str(steps))

    # loop run with vision OFF: look reports the enable hint and never captures
    h.set_settings(model='r5look', actVision=False)
    h.clear_agent_state()
    goal2 = 'Try to look without vision'
    h.send_text(goal2)
    h.wait_agent_started(goal2)
    state = h.wait_agent_paused(timeout=90)  # repeats look to the step cap -> steplimit pause
    narration = '\n'.join(state.get('narration', []))
    check('t17 look without vision reports the Options hint',
          'vision is off' in narration, narration[:300])
    h.disable_act()


if __name__ == '__main__':
    main()
