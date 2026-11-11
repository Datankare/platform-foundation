# Live eval recordings (ADR-038 D3, TASK-204 N-43)

`npm run eval:live` writes one file per prompt here: each live case's input and the model's raw
answer. Commit a refreshed file with the change that refreshed it — the diff is how the model's
answers moved. The deterministic lane replays every file on each PR
(`__tests__/prompt-evals-recordings.test.ts`): each answer must still parse and pass its live
case's assertion, and its input must still be the case's input (a stale recording fails).
