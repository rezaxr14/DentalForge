# Worker contract v1

> **Generated** from the zod schemas in `src/shared/contracts/` by `pnpm contract:docs`. Do not edit by hand —
> `tests/m8-contract-docs.test.ts` fails CI if this file or `docs/worker-openapi.json` is stale.

The worker is **pull-based and outbound-only**: it polls the web app; the web app never calls a worker. That is what lets a
home GPU box behind NAT, a Colab/Kaggle session, or a cloud server all attach to a Vercel deployment.

## Conventions

| | |
|---|---|
| Base path | `/api/worker/v1` |
| Auth | `Authorization: Bearer tf_wrk_<random>` — org-scoped, stored hashed, shown once. Scopes: `jobs:read` < `jobs:write` < `admin` |
| Version | `X-Contract-Version: 1` is **required**. Missing → `400`; unknown major → `426` with `supported: [1]` |
| Worker identity | Job-write endpoints (`events`, `artifacts/presign`, `complete`, `fail`) require `X-Worker-Id` (the id from `/register`). It fences writes to the current lease holder (ADR-0009) |
| Errors | RFC 9457 `application/problem+json` with a stable `code` member |
| Idempotency | `events` are idempotent on `seq`; `complete`/`fail` replay safely for the lease holder; `register` upserts by `name`; `models/register` upserts by `(name, stage)`; `ingest/metrics` upserts the run by `(kind, name)` and rows by `(run, step, name)` / `(run, step, trajectoryRef)` — re-sending a batch is safe |

### Job lifecycle

`queued → claimed → running → succeeded | failed | cancelled | expired`

- **Lease.** `claim` leases a job for `leaseSeconds` (default 60). Every `events` call and heartbeat renews it. If it lapses the job is
  **lazily reaped** (no cron): back to `queued` while attempts remain (max 3), else `expired`. Queued jobs expire after 7 days.
- **Fencing.** After a reap, the old holder's writes get `409 job_not_owner` — stop working on it. A cancelled job gets `409 job_cancelled`
  (and its id appears in the next heartbeat's `cancelJobIds`). A finished job gets `409 job_terminal`.
- **Failure.** `fail` with `retryable: true` requeues while attempts remain (`attemptsRemaining` says how many); otherwise the job is `failed`.
- **Long-poll.** `claim` waits up to `waitMs` (≤ 20 000) and returns `{ jobs: [] }` — never an error — when nothing arrives.
- **Database down.** Every endpoint answers `503` + `Retry-After`; keep polling, do not treat it as a bad token.
- **Uploads.** Artifacts go to a presigned URL, never through the API. The URL pins size and SHA-256 and expires in 15 minutes.

### Problem codes

`invalid_request` · `validation_failed` · `unauthorized` · `forbidden` · `unknown_worker` · `not_found` · `unsupported_contract_version` ·
`job_not_owner` · `job_cancelled` · `job_terminal` · `worker_integration_off` · `unavailable` · `not_implemented` · `internal`

## Endpoints

| Method | Path | Summary | Status |
|---|---|---|---|
| POST | `/register` | Register (upsert by name) and obtain a workerId | implemented |
| POST | `/heartbeat` | Liveness; returns jobs cancelled while you held them | implemented |
| POST | `/jobs/claim` | Long-poll (≤20 s) for jobs; leases them for `leaseSeconds` | implemented |
| POST | `/jobs/{id}/events` | Append events (idempotent on seq); extends the lease | implemented |
| POST | `/jobs/{id}/artifacts/presign` | Presign an artifact upload | implemented |
| POST | `/jobs/{id}/complete` | Complete a job (idempotent for the lease holder) | implemented |
| POST | `/jobs/{id}/fail` | Fail a job; retryable failures requeue while attempts remain | implemented |
| GET | `/images/{imageId}` | Short-lived presigned download URL for an image (variant: original) | implemented |
| POST | `/models/register` | Register a model checkpoint (upsert by name+stage; omitted optional fields keep their stored value) | implemented |
| POST | `/ingest/eval-run` | Ingest one chunk of an evaluation run; the run is identified by runKey; cases are upserted by (run, image_id); n and summary are recomputed from all stored cases | implemented |
| POST | `/ingest/traces` | Ingest verified traces; deduplicated by identity (dataset, image, cohort, mode); per-item outcomes; the dataset and image must already exist | implemented |
| POST | `/ingest/metrics` | Ingest training metrics and reward samples; the run is upserted by (kind, name); idempotent per (run, step, name) | implemented |

Request/response bodies are listed under **Schemas** below.

## Job types

| Type | Payload schema | Result schema |
|---|---|---|
| `system.ping` | `SystemPingPayload` | `SystemPingResult` |
| `yolo.prelabel` | `YoloPrelabelPayload` | `YoloPrelabelResult` |
| `tool.execute` | `ToolExecutePayload` | `ToolExecuteResult` |
| `agent.run` | `AgentRunPayload` | `AgentRunResult` |
| `eval.run` | `EvalRunPayload` | `EvalRunResult` |
| `trace.render_artifacts` | `TraceRenderArtifactsPayload` | `TraceRenderArtifactsResult` |
| `al.score` | `AlScorePayload` | `AlScoreResult` |

`system.ping` is a contract-level diagnostic (not in plan §10.2): it lets an operator verify the whole pipe with no GPU.

## Schemas

### ProblemDetails

```json
{
  "type": "object",
  "properties": {
    "type": {
      "default": "about:blank",
      "type": "string"
    },
    "title": {
      "type": "string"
    },
    "status": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "detail": {
      "type": "string"
    },
    "instance": {
      "type": "string"
    },
    "code": {
      "type": "string"
    }
  },
  "required": [
    "type",
    "title",
    "status"
  ],
  "additionalProperties": false
}
```

### RegisterWorkerRequest

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1
    },
    "runtime": {
      "type": "string",
      "enum": [
        "local-gpu",
        "colab",
        "kaggle",
        "cloud"
      ]
    },
    "software": {
      "default": {},
      "type": "object",
      "properties": {
        "python": {
          "type": "string"
        },
        "torch": {
          "type": "string"
        },
        "cuda": {
          "type": "string"
        },
        "vlmDentalCommit": {
          "type": "string"
        }
      }
    },
    "capabilities": {
      "default": [],
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "job": {
            "type": "string"
          },
          "versions": {
            "default": [
              1
            ],
            "type": "array",
            "items": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          },
          "models": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "job"
        ]
      }
    }
  },
  "required": [
    "name",
    "runtime"
  ]
}
```

### RegisterWorkerResponse

```json
{
  "type": "object",
  "properties": {
    "workerId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "pollIntervalMs": {
      "default": 5000,
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "leaseSeconds": {
      "default": 60,
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "serverTime": {
      "type": "string"
    }
  },
  "required": [
    "workerId",
    "pollIntervalMs",
    "leaseSeconds",
    "serverTime"
  ],
  "additionalProperties": false
}
```

### HeartbeatRequest

```json
{
  "type": "object",
  "properties": {
    "workerId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "status": {
      "default": "idle",
      "type": "string",
      "enum": [
        "idle",
        "busy"
      ]
    },
    "load": {
      "type": "object",
      "properties": {
        "gpuUtil": {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        },
        "vramMb": {
          "type": "number",
          "minimum": 0
        }
      }
    }
  },
  "required": [
    "workerId"
  ]
}
```

### HeartbeatResponse

```json
{
  "type": "object",
  "properties": {
    "cancelJobIds": {
      "default": [],
      "type": "array",
      "items": {
        "type": "string",
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
      }
    }
  },
  "required": [
    "cancelJobIds"
  ],
  "additionalProperties": false
}
```

### ClaimJobsRequest

```json
{
  "type": "object",
  "properties": {
    "workerId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "accepts": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "max": {
      "default": 1,
      "type": "integer",
      "minimum": 1,
      "maximum": 10
    },
    "waitMs": {
      "default": 5000,
      "type": "integer",
      "minimum": 0,
      "maximum": 20000
    }
  },
  "required": [
    "workerId",
    "accepts"
  ]
}
```

### ClaimJobsResponse

```json
{
  "type": "object",
  "properties": {
    "jobs": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
          },
          "type": {
            "type": "string"
          },
          "version": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "payload": {
            "type": "object",
            "propertyNames": {
              "type": "string"
            },
            "additionalProperties": {}
          },
          "attempt": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "leaseExpiresAt": {
            "type": "string"
          },
          "idempotencyKey": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "id",
          "type",
          "version",
          "payload",
          "attempt",
          "leaseExpiresAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "jobs"
  ],
  "additionalProperties": false
}
```

### JobEventsRequest

```json
{
  "type": "object",
  "properties": {
    "events": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "seq": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          },
          "type": {
            "type": "string",
            "enum": [
              "progress",
              "log",
              "turn",
              "artifact",
              "partial"
            ]
          },
          "data": {}
        },
        "required": [
          "seq",
          "type",
          "data"
        ]
      }
    }
  },
  "required": [
    "events"
  ]
}
```

### JobEventsResponse

```json
{
  "type": "object",
  "properties": {
    "accepted": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "leaseExtendedUntil": {
      "type": "string"
    }
  },
  "required": [
    "accepted",
    "leaseExtendedUntil"
  ],
  "additionalProperties": false
}
```

### PresignArtifactRequest

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1
    },
    "mime": {
      "type": "string"
    },
    "bytes": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "sha256": {
      "type": "string",
      "minLength": 64,
      "maxLength": 64
    }
  },
  "required": [
    "name",
    "mime",
    "bytes",
    "sha256"
  ]
}
```

### PresignArtifactResponse

```json
{
  "type": "object",
  "properties": {
    "artifactId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "uploadUrl": {
      "type": "string",
      "format": "uri"
    },
    "headers": {
      "default": {},
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "string"
      }
    }
  },
  "required": [
    "artifactId",
    "uploadUrl",
    "headers"
  ],
  "additionalProperties": false
}
```

### CompleteJobRequest

```json
{
  "type": "object",
  "properties": {
    "result": {},
    "artifactIds": {
      "default": [],
      "type": "array",
      "items": {
        "type": "string",
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
      }
    }
  },
  "required": [
    "result"
  ]
}
```

### CompleteJobResponse

```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    }
  },
  "required": [
    "ok"
  ],
  "additionalProperties": false
}
```

### FailJobRequest

```json
{
  "type": "object",
  "properties": {
    "error": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string"
        },
        "message": {
          "type": "string"
        },
        "retryable": {
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "code",
        "message"
      ]
    }
  },
  "required": [
    "error"
  ]
}
```

### FailJobResponse

```json
{
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "attemptsRemaining": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "ok",
    "attemptsRemaining"
  ],
  "additionalProperties": false
}
```

### RegisterModelRequest

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "kind": {
      "type": "string",
      "enum": [
        "yolo",
        "vlm",
        "api"
      ]
    },
    "stage": {
      "type": "string",
      "enum": [
        "zero_shot",
        "sft",
        "grpo",
        "yolo"
      ]
    },
    "hfPath": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "meta": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    },
    "onnxArtifactId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    }
  },
  "required": [
    "name",
    "kind",
    "stage"
  ]
}
```

### RegisterModelResponse

```json
{
  "type": "object",
  "properties": {
    "modelId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "created": {
      "type": "boolean"
    },
    "name": {
      "type": "string"
    },
    "kind": {
      "type": "string",
      "enum": [
        "yolo",
        "vlm",
        "api"
      ]
    },
    "stage": {
      "type": "string",
      "enum": [
        "zero_shot",
        "sft",
        "grpo",
        "yolo"
      ]
    }
  },
  "required": [
    "modelId",
    "created",
    "name",
    "kind",
    "stage"
  ],
  "additionalProperties": false
}
```

### IngestMetricsRequest

```json
{
  "type": "object",
  "properties": {
    "run": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "sft",
            "grpo",
            "yolo"
          ]
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "config": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {}
        },
        "status": {
          "type": "string",
          "enum": [
            "queued",
            "running",
            "succeeded",
            "failed"
          ]
        }
      },
      "required": [
        "kind",
        "name"
      ]
    },
    "metrics": {
      "default": [],
      "maxItems": 5000,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "step": {
            "type": "integer",
            "minimum": 0,
            "maximum": 2147483647
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          },
          "value": {
            "type": "number"
          }
        },
        "required": [
          "step",
          "name",
          "value"
        ]
      }
    },
    "rewardSamples": {
      "default": [],
      "maxItems": 500,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "step": {
            "type": "integer",
            "minimum": 0,
            "maximum": 2147483647
          },
          "trajectoryRef": {
            "type": "string",
            "minLength": 1,
            "maxLength": 300
          },
          "components": {
            "type": "object",
            "propertyNames": {
              "type": "string",
              "minLength": 1,
              "maxLength": 100
            },
            "additionalProperties": {
              "type": "number"
            }
          },
          "total": {
            "type": "number"
          }
        },
        "required": [
          "step",
          "trajectoryRef",
          "components",
          "total"
        ]
      }
    }
  },
  "required": [
    "run"
  ]
}
```

### IngestMetricsResponse

```json
{
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "runCreated": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "queued",
        "running",
        "succeeded",
        "failed"
      ]
    },
    "metrics": {
      "type": "object",
      "properties": {
        "received": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "inserted": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "received",
        "inserted"
      ],
      "additionalProperties": false
    },
    "rewardSamples": {
      "type": "object",
      "properties": {
        "received": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "inserted": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "received",
        "inserted"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "runId",
    "runCreated",
    "status",
    "metrics",
    "rewardSamples"
  ],
  "additionalProperties": false
}
```

### IngestEvalRunRequest

```json
{
  "type": "object",
  "properties": {
    "runKey": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$"
    },
    "canonicalResize": {
      "default": false,
      "type": "boolean"
    },
    "cases": {
      "minItems": 1,
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "image_id": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "dataset": {
            "type": "string"
          },
          "split": {
            "type": "string"
          },
          "provider": {
            "type": "string"
          },
          "model": {
            "type": "string"
          },
          "ground_truth": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "quadrant": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 4
                },
                "tooth_position": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 8
                },
                "diagnosis": {
                  "type": "string"
                },
                "raw_diagnosis": {
                  "type": "string"
                },
                "confidence": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 1
                },
                "bbox": {
                  "type": "array",
                  "prefixItems": [
                    {
                      "type": "number"
                    },
                    {
                      "type": "number"
                    },
                    {
                      "type": "number"
                    },
                    {
                      "type": "number"
                    }
                  ],
                  "items": false,
                  "minItems": 4,
                  "maxItems": 4
                }
              },
              "required": [
                "quadrant",
                "tooth_position",
                "diagnosis"
              ],
              "additionalProperties": {}
            }
          },
          "predictions": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "quadrant": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 4
                },
                "tooth_position": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "diagnosis": {
                  "type": "string"
                },
                "raw_diagnosis": {
                  "type": "string"
                },
                "confidence": {
                  "anyOf": [
                    {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 1
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "bbox": {
                  "type": "array",
                  "prefixItems": [
                    {
                      "type": "number"
                    },
                    {
                      "type": "number"
                    },
                    {
                      "type": "number"
                    },
                    {
                      "type": "number"
                    }
                  ],
                  "items": false,
                  "minItems": 4,
                  "maxItems": 4
                }
              },
              "required": [
                "quadrant",
                "tooth_position",
                "diagnosis"
              ],
              "additionalProperties": {}
            }
          },
          "matched_pairs": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "gt": {
                  "type": "object",
                  "properties": {
                    "quadrant": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 4
                    },
                    "tooth_position": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 8
                    },
                    "diagnosis": {
                      "type": "string"
                    },
                    "raw_diagnosis": {
                      "type": "string"
                    },
                    "confidence": {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 1
                    },
                    "bbox": {
                      "type": "array",
                      "prefixItems": [
                        {
                          "type": "number"
                        },
                        {
                          "type": "number"
                        },
                        {
                          "type": "number"
                        },
                        {
                          "type": "number"
                        }
                      ],
                      "items": false,
                      "minItems": 4,
                      "maxItems": 4
                    }
                  },
                  "required": [
                    "quadrant",
                    "tooth_position",
                    "diagnosis"
                  ],
                  "additionalProperties": {}
                },
                "pred": {
                  "type": "object",
                  "properties": {
                    "quadrant": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 4
                    },
                    "tooth_position": {
                      "type": "integer",
                      "minimum": -9007199254740991,
                      "maximum": 9007199254740991
                    },
                    "diagnosis": {
                      "type": "string"
                    },
                    "raw_diagnosis": {
                      "type": "string"
                    },
                    "confidence": {
                      "anyOf": [
                        {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 1
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "bbox": {
                      "type": "array",
                      "prefixItems": [
                        {
                          "type": "number"
                        },
                        {
                          "type": "number"
                        },
                        {
                          "type": "number"
                        },
                        {
                          "type": "number"
                        }
                      ],
                      "items": false,
                      "minItems": 4,
                      "maxItems": 4
                    }
                  },
                  "required": [
                    "quadrant",
                    "tooth_position",
                    "diagnosis"
                  ],
                  "additionalProperties": {}
                },
                "fdi_match": {
                  "type": "boolean"
                },
                "exact_match": {
                  "type": "boolean"
                },
                "closeness": {
                  "type": "number"
                },
                "spatial": {
                  "type": "number"
                },
                "diag_sim": {
                  "type": "number"
                }
              },
              "required": [
                "gt",
                "pred",
                "fdi_match",
                "exact_match",
                "closeness",
                "spatial",
                "diag_sim"
              ],
              "additionalProperties": {}
            }
          },
          "fdi_precision": {
            "type": "number"
          },
          "fdi_recall": {
            "type": "number"
          },
          "fdi_f1": {
            "type": "number"
          },
          "exact_precision": {
            "type": "number"
          },
          "exact_recall": {
            "type": "number"
          },
          "exact_f1": {
            "type": "number"
          },
          "closeness_score": {
            "type": "number"
          },
          "spatial_proximity": {
            "type": "number"
          },
          "diagnostic_similarity": {
            "type": "number"
          },
          "fdi_correct": {
            "type": "boolean"
          },
          "quadrant_correct": {
            "type": "boolean"
          },
          "tooth_position_correct": {
            "type": "boolean"
          },
          "diagnosis_correct": {
            "type": "boolean"
          },
          "exact_match": {
            "type": "boolean"
          },
          "all_exact_match": {
            "type": "boolean"
          },
          "final_answer": {},
          "raw_output": {
            "type": "string"
          },
          "format_ok": {
            "type": "boolean"
          },
          "finish_reason": {
            "type": "string"
          },
          "confidence": {
            "type": [
              "number",
              "null"
            ]
          },
          "timestamp": {
            "type": [
              "string",
              "number"
            ]
          }
        },
        "required": [
          "image_id",
          "dataset",
          "split",
          "provider",
          "model",
          "ground_truth",
          "predictions",
          "matched_pairs",
          "fdi_precision",
          "fdi_recall",
          "fdi_f1",
          "exact_precision",
          "exact_recall",
          "exact_f1",
          "closeness_score",
          "spatial_proximity",
          "diagnostic_similarity",
          "fdi_correct",
          "quadrant_correct",
          "tooth_position_correct",
          "diagnosis_correct",
          "exact_match",
          "all_exact_match",
          "raw_output",
          "format_ok",
          "finish_reason"
        ],
        "additionalProperties": {}
      }
    }
  },
  "required": [
    "runKey",
    "cases"
  ]
}
```

### IngestEvalRunResponse

```json
{
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "runCreated": {
      "type": "boolean"
    },
    "dataset": {
      "type": "string"
    },
    "split": {
      "type": "string"
    },
    "provider": {
      "type": "string"
    },
    "model": {
      "type": "string"
    },
    "n": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "cases": {
      "type": "object",
      "properties": {
        "received": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "inserted": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "received",
        "inserted"
      ],
      "additionalProperties": false
    },
    "summary": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "number"
      }
    }
  },
  "required": [
    "runId",
    "runCreated",
    "dataset",
    "split",
    "provider",
    "model",
    "n",
    "cases",
    "summary"
  ],
  "additionalProperties": false
}
```

### IngestTracesRequest

```json
{
  "type": "object",
  "properties": {
    "source": {
      "type": "object",
      "properties": {
        "cohort": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9_]{0,63}$"
        },
        "mode": {
          "type": "string",
          "enum": [
            "with_tools",
            "no_tools"
          ]
        },
        "verified": {
          "default": true,
          "type": "boolean"
        },
        "sourceFile": {
          "type": "string",
          "minLength": 1,
          "maxLength": 300
        }
      },
      "required": [
        "cohort",
        "mode"
      ]
    },
    "traces": {
      "minItems": 1,
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "image_id": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "image_path": {
            "type": "string"
          },
          "dataset": {
            "default": "dentex",
            "type": "string"
          },
          "ground_truth": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "quadrant": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 4
                },
                "tooth_position": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 8
                },
                "diagnosis": {
                  "type": "string"
                },
                "raw_diagnosis": {
                  "type": "string"
                },
                "confidence": {
                  "type": "number",
                  "minimum": 0,
                  "maximum": 1
                },
                "bbox": {
                  "type": "array",
                  "prefixItems": [
                    {
                      "type": "number"
                    },
                    {
                      "type": "number"
                    },
                    {
                      "type": "number"
                    },
                    {
                      "type": "number"
                    }
                  ],
                  "items": false,
                  "minItems": 4,
                  "maxItems": 4
                }
              },
              "required": [
                "quadrant",
                "tooth_position",
                "diagnosis"
              ],
              "additionalProperties": {}
            }
          },
          "turns": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "turn": {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                },
                "raw_output": {
                  "type": "string"
                },
                "parsed": {
                  "anyOf": [
                    {
                      "type": "object",
                      "properties": {
                        "thought": {
                          "type": "string"
                        },
                        "tool_calls": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "tool": {
                                "type": "string"
                              },
                              "args": {
                                "type": "object",
                                "propertyNames": {
                                  "type": "string"
                                },
                                "additionalProperties": {}
                              }
                            },
                            "additionalProperties": {}
                          }
                        },
                        "final_answer": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "quadrant": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 4
                              },
                              "tooth_position": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 8
                              },
                              "diagnosis": {
                                "type": "string"
                              },
                              "raw_diagnosis": {
                                "type": "string"
                              },
                              "confidence": {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1
                              },
                              "bbox": {
                                "type": "array",
                                "prefixItems": [
                                  {
                                    "type": "number"
                                  },
                                  {
                                    "type": "number"
                                  },
                                  {
                                    "type": "number"
                                  },
                                  {
                                    "type": "number"
                                  }
                                ],
                                "items": false,
                                "minItems": 4,
                                "maxItems": 4
                              }
                            },
                            "required": [
                              "quadrant",
                              "tooth_position",
                              "diagnosis"
                            ],
                            "additionalProperties": {}
                          }
                        }
                      },
                      "additionalProperties": {}
                    },
                    {
                      "type": "null"
                    }
                  ]
                },
                "status": {
                  "type": "string"
                },
                "tool_calls_this_turn": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "tool_name": {
                        "type": "string"
                      },
                      "tool_args": {
                        "type": "object",
                        "propertyNames": {
                          "type": "string"
                        },
                        "additionalProperties": {}
                      },
                      "tool_ok": {
                        "type": "boolean"
                      },
                      "tool_error": {
                        "type": "string"
                      },
                      "true_bbox": {
                        "type": "array",
                        "prefixItems": [
                          {
                            "type": "number"
                          },
                          {
                            "type": "number"
                          },
                          {
                            "type": "number"
                          },
                          {
                            "type": "number"
                          }
                        ],
                        "items": false,
                        "minItems": 4,
                        "maxItems": 4
                      },
                      "perturb_tier": {
                        "type": "string",
                        "enum": [
                          "small",
                          "big"
                        ]
                      }
                    },
                    "required": [
                      "tool_name",
                      "tool_args",
                      "tool_ok"
                    ],
                    "additionalProperties": {}
                  }
                }
              },
              "required": [
                "turn"
              ],
              "additionalProperties": {}
            }
          },
          "tool_calls": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              {
                "type": "array",
                "items": {}
              }
            ]
          },
          "final_answer": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "quadrant": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 4
                    },
                    "tooth_position": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 8
                    },
                    "diagnosis": {
                      "type": "string"
                    },
                    "raw_diagnosis": {
                      "type": "string"
                    },
                    "confidence": {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 1
                    },
                    "bbox": {
                      "type": "array",
                      "prefixItems": [
                        {
                          "type": "number"
                        },
                        {
                          "type": "number"
                        },
                        {
                          "type": "number"
                        },
                        {
                          "type": "number"
                        }
                      ],
                      "items": false,
                      "minItems": 4,
                      "maxItems": 4
                    }
                  },
                  "required": [
                    "quadrant",
                    "tooth_position",
                    "diagnosis"
                  ],
                  "additionalProperties": {}
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "messages": {
            "type": "array",
            "items": {}
          },
          "format_ok": {
            "type": "boolean"
          },
          "verifier_reason": {
            "type": "string"
          }
        },
        "required": [
          "image_id",
          "ground_truth",
          "turns",
          "tool_calls",
          "final_answer",
          "format_ok"
        ],
        "additionalProperties": {}
      }
    }
  },
  "required": [
    "source",
    "traces"
  ]
}
```

### IngestTracesResponse

```json
{
  "type": "object",
  "properties": {
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "index": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "imageId": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "outcome": {
            "type": "string",
            "enum": [
              "inserted",
              "existing",
              "rejected"
            ]
          },
          "traceId": {
            "type": "string",
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
          },
          "sameContent": {
            "type": "boolean"
          },
          "reason": {
            "type": "string",
            "enum": [
              "unknown_dataset",
              "unknown_image",
              "invalid_trace"
            ]
          }
        },
        "required": [
          "index",
          "imageId",
          "outcome"
        ],
        "additionalProperties": false
      }
    },
    "inserted": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "existing": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "rejected": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "results",
    "inserted",
    "existing",
    "rejected"
  ],
  "additionalProperties": false
}
```

### CreateJobRequest

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "enum": [
        "system.ping",
        "yolo.prelabel",
        "tool.execute",
        "agent.run",
        "eval.run",
        "trace.render_artifacts",
        "al.score"
      ]
    },
    "payload": {
      "default": {},
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    },
    "priority": {
      "default": 0,
      "type": "integer",
      "minimum": 0,
      "maximum": 10
    }
  },
  "required": [
    "type"
  ]
}
```

### Job

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "type": {
      "type": "string"
    },
    "version": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "status": {
      "type": "string",
      "enum": [
        "queued",
        "claimed",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "expired"
      ]
    },
    "priority": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "attempts": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "maxAttempts": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "payload": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    },
    "result": {
      "anyOf": [
        {},
        {
          "type": "null"
        }
      ]
    },
    "error": {
      "anyOf": [
        {},
        {
          "type": "null"
        }
      ]
    },
    "artifactIds": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "claimedBy": {
      "type": [
        "string",
        "null"
      ]
    },
    "createdAt": {
      "type": "string"
    },
    "updatedAt": {
      "type": "string"
    }
  },
  "required": [
    "id",
    "type",
    "version",
    "status",
    "priority",
    "attempts",
    "maxAttempts",
    "payload",
    "result",
    "error",
    "artifactIds",
    "claimedBy",
    "createdAt",
    "updatedAt"
  ],
  "additionalProperties": false
}
```

### JobEvent

```json
{
  "type": "object",
  "properties": {
    "seq": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "type": {
      "type": "string"
    },
    "data": {},
    "createdAt": {
      "type": "string"
    }
  },
  "required": [
    "seq",
    "type",
    "data",
    "createdAt"
  ],
  "additionalProperties": false
}
```

### JobEventsPage

```json
{
  "type": "object",
  "properties": {
    "job": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string"
        },
        "type": {
          "type": "string"
        },
        "version": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "status": {
          "type": "string",
          "enum": [
            "queued",
            "claimed",
            "running",
            "succeeded",
            "failed",
            "cancelled",
            "expired"
          ]
        },
        "priority": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "attempts": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "maxAttempts": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "payload": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {}
        },
        "result": {
          "anyOf": [
            {},
            {
              "type": "null"
            }
          ]
        },
        "error": {
          "anyOf": [
            {},
            {
              "type": "null"
            }
          ]
        },
        "artifactIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "claimedBy": {
          "type": [
            "string",
            "null"
          ]
        },
        "createdAt": {
          "type": "string"
        },
        "updatedAt": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "type",
        "version",
        "status",
        "priority",
        "attempts",
        "maxAttempts",
        "payload",
        "result",
        "error",
        "artifactIds",
        "claimedBy",
        "createdAt",
        "updatedAt"
      ],
      "additionalProperties": false
    },
    "events": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "seq": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "type": {
            "type": "string"
          },
          "data": {},
          "createdAt": {
            "type": "string"
          }
        },
        "required": [
          "seq",
          "type",
          "data",
          "createdAt"
        ],
        "additionalProperties": false
      }
    },
    "nextAfter": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "done": {
      "type": "boolean"
    }
  },
  "required": [
    "job",
    "events",
    "nextAfter",
    "done"
  ],
  "additionalProperties": false
}
```

### SystemPingPayload

```json
{
  "type": "object",
  "properties": {
    "message": {
      "default": "ping",
      "type": "string",
      "maxLength": 200
    },
    "steps": {
      "default": 3,
      "type": "integer",
      "minimum": 0,
      "maximum": 20
    }
  }
}
```

### SystemPingResult

```json
{
  "type": "object",
  "properties": {
    "echo": {
      "type": "string"
    },
    "workerName": {
      "type": "string"
    },
    "steps": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "echo",
    "workerName",
    "steps"
  ],
  "additionalProperties": false
}
```

### YoloPrelabelPayload

```json
{
  "type": "object",
  "properties": {
    "imageId": {
      "anyOf": [
        {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "modelId": {
      "type": "string"
    },
    "confThreshold": {
      "default": 0.25,
      "type": "number",
      "minimum": 0,
      "maximum": 1
    }
  },
  "required": [
    "imageId",
    "modelId"
  ]
}
```

### YoloPrelabelResult

```json
{
  "type": "object",
  "properties": {
    "modelId": {
      "type": "string"
    },
    "inferenceMs": {
      "type": "number"
    },
    "boxes": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "bbox": {
            "type": "array",
            "prefixItems": [
              {
                "type": "number"
              },
              {
                "type": "number"
              },
              {
                "type": "number"
              },
              {
                "type": "number"
              }
            ],
            "items": false,
            "minItems": 4,
            "maxItems": 4
          },
          "conf": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "classIdx": {
            "type": "integer",
            "minimum": 0,
            "maximum": 31
          },
          "fdiQuadrant": {
            "type": "integer",
            "minimum": 1,
            "maximum": 4
          },
          "fdiPosition": {
            "type": "integer",
            "minimum": 1,
            "maximum": 8
          }
        },
        "required": [
          "bbox",
          "conf",
          "classIdx",
          "fdiQuadrant",
          "fdiPosition"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "modelId",
    "inferenceMs",
    "boxes"
  ],
  "additionalProperties": false
}
```

### ToolExecutePayload

```json
{
  "type": "object",
  "properties": {
    "imageId": {
      "anyOf": [
        {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "tool": {
      "type": "string",
      "enum": [
        "zoom_crop",
        "window_level",
        "locate_tooth",
        "fdi_label",
        "denoise",
        "contralateral_compare",
        "enhance_contrast",
        "nudge_crop"
      ]
    },
    "args": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    },
    "view": {
      "default": "native",
      "type": "string",
      "enum": [
        "native",
        "canonical"
      ]
    }
  },
  "required": [
    "imageId",
    "tool",
    "args"
  ]
}
```

### ToolExecuteResult

```json
{
  "type": "object",
  "properties": {
    "kind": {
      "type": "string",
      "enum": [
        "image",
        "data"
      ]
    },
    "data": {},
    "artifactId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "width": {
      "type": "number"
    },
    "height": {
      "type": "number"
    },
    "durationMs": {
      "type": "number"
    }
  },
  "required": [
    "kind",
    "durationMs"
  ],
  "additionalProperties": false
}
```

### AgentRunPayload

```json
{
  "type": "object",
  "properties": {
    "imageId": {
      "anyOf": [
        {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      ]
    },
    "modelId": {
      "type": "string"
    },
    "mode": {
      "type": "string",
      "enum": [
        "with_tools",
        "no_tools"
      ]
    },
    "maxTurns": {
      "default": 30,
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "maxToolCalls": {
      "default": 50,
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "canonicalResize": {
      "default": false,
      "type": "boolean"
    },
    "seed": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "imageId",
    "modelId",
    "mode"
  ]
}
```

### AgentRunResult

```json
{
  "type": "object",
  "properties": {
    "finalAnswer": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "quadrant": {
            "type": "integer",
            "minimum": 1,
            "maximum": 4
          },
          "tooth_position": {
            "type": "integer",
            "minimum": 1,
            "maximum": 8
          },
          "diagnosis": {
            "type": "string"
          },
          "raw_diagnosis": {
            "type": "string"
          },
          "confidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "bbox": {
            "type": "array",
            "prefixItems": [
              {
                "type": "number"
              },
              {
                "type": "number"
              },
              {
                "type": "number"
              },
              {
                "type": "number"
              }
            ],
            "items": false,
            "minItems": 4,
            "maxItems": 4
          }
        },
        "required": [
          "quadrant",
          "tooth_position",
          "diagnosis"
        ],
        "additionalProperties": {}
      }
    },
    "nTurns": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "nToolCalls": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "formatOk": {
      "type": "boolean"
    },
    "rewardComponents": {
      "type": "object",
      "properties": {
        "accuracy": {
          "type": "number"
        },
        "format": {
          "type": "number"
        },
        "toolValidity": {
          "type": "number"
        },
        "efficiency": {
          "type": "number"
        }
      },
      "required": [
        "accuracy",
        "format",
        "toolValidity",
        "efficiency"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "finalAnswer",
    "nTurns",
    "nToolCalls",
    "formatOk"
  ],
  "additionalProperties": false
}
```

### EvalRunPayload

```json
{
  "type": "object",
  "properties": {
    "modelId": {
      "type": "string"
    },
    "dataset": {
      "type": "string"
    },
    "split": {
      "default": "test",
      "type": "string"
    },
    "canonicalResize": {
      "default": false,
      "type": "boolean"
    },
    "imageIds": {
      "type": "array",
      "items": {
        "type": "integer",
        "minimum": -9007199254740991,
        "maximum": 9007199254740991
      }
    }
  },
  "required": [
    "modelId",
    "dataset"
  ]
}
```

### EvalRunResult

```json
{
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    },
    "n": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "summary": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "number"
      }
    }
  },
  "required": [
    "runId",
    "n",
    "summary"
  ],
  "additionalProperties": false
}
```

### TraceRenderArtifactsPayload

```json
{
  "type": "object",
  "properties": {
    "traceId": {
      "type": "string",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
    }
  },
  "required": [
    "traceId"
  ]
}
```

### TraceRenderArtifactsResult

```json
{
  "type": "object",
  "properties": {
    "artifacts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "turnIdx": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "callIdx": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "artifactId": {
            "type": "string",
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
          }
        },
        "required": [
          "turnIdx",
          "callIdx",
          "artifactId"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "artifacts"
  ],
  "additionalProperties": false
}
```

### AlScorePayload

```json
{
  "type": "object",
  "properties": {
    "imageIds": {
      "type": "array",
      "items": {
        "anyOf": [
          {
            "type": "string",
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
          },
          {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        ]
      }
    },
    "modelId": {
      "type": "string"
    }
  },
  "required": [
    "imageIds",
    "modelId"
  ]
}
```

### AlScoreResult

```json
{
  "type": "object",
  "properties": {
    "scores": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "imageId": {
            "anyOf": [
              {
                "type": "string",
                "format": "uuid",
                "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
              },
              {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            ]
          },
          "meanConf": {
            "type": "number"
          },
          "minConf": {
            "type": "number"
          },
          "entropy": {
            "type": "number"
          },
          "nBoxes": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "imageId",
          "meanConf",
          "minConf",
          "entropy",
          "nBoxes"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "scores"
  ],
  "additionalProperties": false
}
```
