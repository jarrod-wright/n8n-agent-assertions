# Changelog

## 2026-11-17 - the checks run in CI; schedules and probes hardened

- New: `harness/run.mjs`. One command reruns the passing and failing case for every check, checks each file imports and is wired as documented, and runs the public linter over every workflow with every finding justified in the README. CI runs it on every push.
- The four workflows now pin their schedule timezone to `Etc/UTC`, so a schedule fires at the same instant on any host.
- The network calls (the credential probes and the Golden case call) now retry bounded: up to 3 tries, 5 seconds apart, so a transient network failure does not raise a false alert.
