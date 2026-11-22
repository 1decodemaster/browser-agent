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
import signal
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

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
        self.page = self.context.new_page()
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

    def wait_agent_finished(self, timeout=60):
        deadline = time.time() + timeout
        state = None
        while time.time() < deadline:
            state = self.agent_state()
            if state and state.get('status') == 'finished':
                time.sleep(0.5)  # let the error/answer notification land
                return self.agent_state()
            time.sleep(0.3)
        raise TimeoutError(f'agent did not finish: {state}')

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
          'expected truncation note (page must exceed the 280 budget)')


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


if __name__ == '__main__':
    main()
