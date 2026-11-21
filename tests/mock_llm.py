#!/usr/bin/env python3
"""Mock OpenAI-compatible streaming LLM server for browser-agent e2e tests.

Behaviors are selected via the model name in the request:
  scripted              - adaptive scripted agent: parses the element index from
                          the prompt and returns the next action JSON (dropdown
                          options are only clickable if they reached the index).
  delay-first-<seconds> - sleep <seconds> before sending ANY byte, then answer
                          scripted (first-token timeout probe).
  dribble-<seconds>     - send the first chunk immediately, then stream the rest
                          over <seconds> (total-timeout probe).
  memsched              - working-memory schedule: returns per-request `memory`
                          and `effort` fields and echoes what it RECEIVED
                          (memory marker + reasoning_effort / thinking flag)
                          in `thought`, making the loop observable in narration.

Debug: GET /debug/requests?model=<name> - recorded request facts;
       GET /debug/reset - clear records.
"""
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8902

LONG_MEMORY = 'MEM-TRUNC: ' + 'x' * 1150 + 'TRUNC-TAIL' + 'y' * 40 + 'TRUNC-OVERFLOW'

MEMORY_SCHEDULE = [
    {'memory': 'MEM-A: goal needs DEL to SFO one-way Dec 24; origin works with type+wait+submit',
     'effort': 'medium'},
    {'memory': 'MEM-B: dest suggestions open on input; pick from Recently appeared',
     'effort': 'low'},
    {'memory': LONG_MEMORY,
     'effort': 'banana'},
    {'memory': 'MEM-C: search submitted, expect results page',
     'effort': 'off'},
    {'memory': 'MEM-D: final step', 'effort': 'high'},
    {'memory': 'MEM-E: spare', 'effort': 'medium'},
]

RECORDS = {}


def scripted_actions(prompt: str) -> list:
    entries = re.findall(r'\[(\d+)\] ([a-z]+) "([^"]*)"', prompt)
    entries = [(int(eid), role, name) for eid, role, name in entries]

    def find(pred):
        for eid, role, name in entries:
            if pred(role, name):
                return eid
        return None

    origin_set = any('Remove origin' in name for _, _, name in entries)
    dest_set = any('Remove destination' in name for _, _, name in entries)
    results_visible = 'flights found' in prompt
    delhi_opt = find(lambda r, n: 'New Delhi' in n and r in ('option', 'button', 'link'))
    sf_opt = find(lambda r, n: 'San Francisco' in n and r in ('option', 'button', 'link'))
    origin_field = find(
        lambda r, n: r in ('combobox', 'textbox', 'searchbox') and 'Origin' in n
    )
    dest_field = find(
        lambda r, n: r in ('combobox', 'textbox', 'searchbox') and 'Destination' in n
    )
    search_btn = find(lambda r, n: r == 'button' and 'Search flights' in n)

    if delhi_opt and not origin_set:
        actions = [{'op': 'click', 'target': delhi_opt}]
        thought = 'origin suggestions are in the index, click New Delhi'
    elif sf_opt and not dest_set:
        actions = [{'op': 'click', 'target': sf_opt}]
        thought = 'destination suggestions are in the index, click San Francisco'
    elif origin_field and not origin_set:
        # mirror the issue's kayak flow: type, wait for the dropdown, then a
        # blind submit that commits the top suggestion
        actions = [
            {'op': 'type', 'target': origin_field, 'text': 'DEL'},
            {'op': 'wait', 'ms': 400},
            {'op': 'type', 'target': origin_field, 'text': 'DEL', 'submit': True},
        ]
        thought = 'type DEL, wait for suggestions, submit to pick the top one'
    elif dest_field and not dest_set:
        actions = [
            {'op': 'type', 'target': dest_field, 'text': 'SFO'},
            {'op': 'wait', 'ms': 400},
        ]
        thought = 'type SFO into destination, wait for suggestions'
    elif search_btn and not results_visible:
        actions = [{'op': 'click', 'target': search_btn}, {'op': 'wait', 'ms': 500}]
        thought = 'origin and destination are set, run the search'
    elif results_visible:
        actions = [{
            'op': 'done',
            'summary': 'Flight search completed: 8 flights found DEL -> SFO for Dec 24.',
        }]
        thought = 'results are visible, done'
    else:
        actions = [{'op': 'wait', 'ms': 500}]
        thought = 'nothing actionable yet, wait'
    return actions, thought


def is_agent_step(prompt: str) -> bool:
    return 'Element index:' in prompt


def received_memory(prompt: str) -> str:
    match = re.search(r'Working notes[^\n]*:\n(.*?)\n+Element index:', prompt, re.S)
    return match.group(1) if match else ''


def memsched_reply(payload, prompt: str):
    if not is_agent_step(prompt):
        return json.dumps({'answer': 'Run completed.'}), 'plain'
    records = RECORDS.setdefault('memsched', [])
    step_index = sum(1 for record in records if record.get('step'))
    schedule = MEMORY_SCHEDULE[min(step_index, len(MEMORY_SCHEDULE) - 1)]
    received = received_memory(prompt)
    marker = received[:5] if received else 'none'
    tail = 'Y' if 'TRUNC-TAIL' in received else 'N'
    over = 'Y' if 'TRUNC-OVERFLOW' in received else 'N'
    effort = payload.get('reasoning_effort')
    thinking_off = (payload.get('chat_template_kwargs') or {}).get('enable_thinking') is False
    recv_eff = 'off' if thinking_off else (effort if effort else 'none')
    actions, _ = scripted_actions(prompt)
    thought = f'recv_mem={marker} tail={tail} over={over} recv_eff={recv_eff}'
    return json.dumps({
        'v': 2,
        'thought': thought,
        'memory': schedule['memory'],
        'effort': schedule['effort'],
        'actions': actions,
    }), 'json'


def last_user_content(messages):
    content = ''
    for message in reversed(messages):
        if message.get('role') == 'user':
            content = message.get('content', '')
            if isinstance(content, list):
                content = ' '.join(
                    part.get('text', '') for part in content if isinstance(part, dict)
                )
            break
    return content


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        sys.stderr.write('[mock-llm] %s\n' % (fmt % args))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith('/v1/models'):
            body = json.dumps({'data': [{'id': 'scripted'}, {'id': 'delay-first-6'}, {'id': 'dribble-9'}]})
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body.encode())
        elif parsed.path.startswith('/debug/requests'):
            model = parse_qs(parsed.query).get('model', [''])[0]
            body = json.dumps(RECORDS.get(model, []))
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body.encode())
        elif parsed.path.startswith('/debug/reset'):
            RECORDS.clear()
            body = '{}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body.encode())
        else:
            self.send_error(404)

    def do_POST(self):
        if not self.path.startswith('/v1/chat/completions'):
            self.send_error(404)
            return
        length = int(self.headers.get('Content-Length', 0))
        payload = json.loads(self.rfile.read(length) or b'{}')
        model = payload.get('model', 'scripted')
        prompt = last_user_content(payload.get('messages', []))
        reply, kind = self.build_reply(payload, prompt, model)
        records = RECORDS.setdefault(model, [])
        records.append({
            'step': is_agent_step(prompt),
            'reasoning_effort': payload.get('reasoning_effort'),
            'enable_thinking': (payload.get('chat_template_kwargs') or {}).get('enable_thinking'),
            'has_memory_section': 'Working notes' in prompt,
            'memory_head': received_memory(prompt)[:12],
            'kind': kind,
        })
        del records[:-60]

        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')
        self.end_headers()

        def emit(text):
            chunk = json.dumps({'choices': [{'delta': {'content': text}}]})
            self.wfile.write(f'data: {chunk}\n\n'.encode())
            self.wfile.flush()

        delay_first = re.fullmatch(r'delay-first-(\d+)', model)
        dribble = re.fullmatch(r'dribble-(\d+)', model)

        try:
            if delay_first:
                time.sleep(int(delay_first.group(1)))
                emit(reply)
            elif dribble:
                total = int(dribble.group(1))
                emit(reply[:20])
                rest = reply[20:]
                step = max(total / max(len(rest), 1), 0.01)
                for ch in rest:
                    time.sleep(step)
                    emit(ch)
            else:
                for i in range(0, len(reply), 24):
                    emit(reply[i:i + 24])
                    time.sleep(0.01)
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def build_reply(self, payload, prompt, model):
        if model == 'memsched':
            return memsched_reply(payload, prompt)
        if is_agent_step(prompt):
            actions, thought = scripted_actions(prompt)
            return json.dumps({'v': 1, 'thought': thought, 'actions': actions}), 'json'
        return json.dumps({'answer': 'Run completed.'}), 'plain'


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'mock llm on http://127.0.0.1:{PORT}', flush=True)
    server.serve_forever()
