# Deployment (#144)

## Pipeline

1. **Verify** — CI jobs (contract sync, migrations, build, tests, actionlint,
   shellcheck).
2. **Image** — buildx pushes `ghcr.io/<repo>@sha256:<digest>`, cosign signs the
   digest, Syft emits an SPDX SBOM.
3. **Staging** — `deploy-env.yml` verifies the cosign identity, lints migrations
   and runs `helm upgrade --install --atomic`.
4. **Staging checks** — readiness must hold 3 consecutive probes, indexer lag
   must be ≤ 120 ledgers and the cursor must advance.
5. **Production** — same reusable workflow with the production GitHub
   Environment (required reviewers).
6. **Production checks** — 5 consecutive readiness probes plus the same lag,
   cursor and Prometheus checks.

Secrets (kubeconfig, Helm values) live in GitHub Environments. The image is
referenced by digest, never by a mutable tag.

## Migration rule: expand / contract

`scripts/check-migration-compat.mjs` (run on the migrations changed in a PR/release) blocks:

- `DROP TABLE`, `DROP COLUMN`, `RENAME`;
- `ALTER COLUMN … TYPE`;
- `SET NOT NULL`;
- `CREATE INDEX` without `CONCURRENTLY`.

Ship additive migrations first, deploy both versions, then remove old columns
in a later release. `--allow-breaking` exists only for an explicitly approved
maintenance window.

## Rollback

Roll back the Helm release to the previous revision. If the new release added
only expand-phase changes, the old code keeps working. Do **not** roll back the
database; forward-fix instead.

## Post-deploy checks

```bash
API_URL=https://api.example \
INDEXER_STATUS_URL=https://api.example/internal/indexer-status \
MAX_INDEXER_LAG_LEDGERS=120 \
PROMETHEUS_URL=https://prometheus.example \
KUBE_NAMESPACE=oracledesk DEPLOYMENTS="api indexer worker" \
DIGEST=<sha256> ./scripts/post-deploy-checks.sh
```

Checks are read-only. `SKIP_KUBE=1` omits the digest check in local tests.
