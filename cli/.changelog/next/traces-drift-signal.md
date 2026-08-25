### traces: drift signal for topic buckets

`agents traces sync` now computes a **drift signal** for each topic bucket by comparing today's error and stall rates against a 14-day rolling history stored inside the shard. Buckets that cross a 0.20 absolute-delta threshold are marked `degrading` or `improving`; the rest are `stable`. Buckets with fewer than 3 historical days are skipped to avoid noise on fresh deployments.

The shard now carries two new fields:

- `bucketHistory` — rolling 14-day array of per-bucket `BucketStats` (errorRate, stallRate)
- `driftSignals` — `DriftSignal[]` for the current sync, sorted by errorDelta descending

`--dry-run --out <dir>` seeds history from the previously written `index.json` in the output directory, so successive local runs accumulate signal without hitting the network.
