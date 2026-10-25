# Evidence for openclaw/openclaw#167951 at 443e4ce

Retained artifacts from the 2026-10-25 testbox run described in the PR comment: stock v2026.10.7 → candidate 443e4ce.

- `audio/`: the 9 decoded MP3 samples (A stock, B candidate, C config rate, C WebChat directive, D tts-2 / legacy, E Talk 0.8 / 1.0 / 1.4); `audio-receipts.json` has hashes, durations and decode results.
- `native-wire-evidence.json`, `native-request-bodies/`: captured CLI request bodies with SHA-256 bindings (no auth headers).
- `phase-wire-summary.json`, `gateway-phase-summary.json`: per-phase request/status summaries (WebChat and Talk observed in-gateway).
- `*-public-settings.jsonl`, `B-settings-comparison.json`, `*-secret-ref.json`: public settings before/after upgrade and the credential reference descriptor (never a value).
- `*-result.json`, `E-talk-*.json`, `source-bindings.json`: per-phase results and image/source bindings.
