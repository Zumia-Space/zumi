// node --test scripts/check-power-egress.test.mjs : the egress check (R3) catches a socket or an HTTP stack anywhere but zumi-egress.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from './check-power-egress.mjs';

const f = (path, text) => ({ path, text });
const hits = (files) => scan(files).map((v) => `${v.path}:${v.token}`);

test('bite: every socket and HTTP-stack token outside zumi-egress', () => {
  for (const [token, line] of [
    ['TcpStream', 'let s = std::net::TcpStream::connect("1.2.3.4:80");'],
    ['TcpListener', 'let l = TcpListener::bind("127.0.0.1:0");'],
    ['UdpSocket', 'let u = UdpSocket::bind("0.0.0.0:0");'],
    ['reqwest::', 'let c = reqwest::Client::new();'],
    ['hyper::', 'use hyper::Client;'],
    ['tokio::net', 'use tokio::net::TcpStream;'],
  ]) {
    const got = hits([f('tauri/zumi-agent-loop/src/new_tool.rs', `fn x() {\n  ${line}\n}`)]);
    assert.ok(got.includes(`tauri/zumi-agent-loop/src/new_tool.rs:${token}`), `${token}: ${got}`);
  }
  assert.ok(hits([f('tauri/src-tauri/src/agent_wiring.rs', 'use reqwest::blocking::get;')]).length > 0, 'the host crate too');
});

test('twin: the same tokens inside zumi-egress, and the word in a test block or a plain word, pass', () => {
  assert.deepEqual(hits([f('tauri/zumi-egress/src/lib.rs', 'use reqwest::Client; use tokio::net::lookup_host;')]), []);
  assert.deepEqual(hits([f('tauri/zumi-egress/src/fixture.rs', 'let l = TcpListener::bind("127.0.0.1:0");')]), []);
  assert.deepEqual(hits([f('tauri/zumi-agent-loop/src/a.rs', 'fn real() {}\n#[cfg(test)]\nmod tests { use std::net::TcpStream; }')]), []);
  assert.deepEqual(hits([f('tauri/zumi-agent-loop/src/a.rs', '// the egress crate owns every socket; a reqwest user goes through it')]), [], 'a comment without the call syntax');
  assert.deepEqual(hits([f('tauri/zumi-agent-loop/src/a.rs', 'let n = "TcpStreamer";')]), [], 'a longer identifier is not the token');
});
