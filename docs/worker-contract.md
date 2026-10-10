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
| Idempotency | `events` are idempotent on `seq`; `complete`/`fail` replay safely for the lease holder; `register` upserts by `name` |

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
| POST | `/models/register` | Register a model checkpoint | not implemented (501) |
| POST | `/ingest/eval-run` | Ingest eval cases | not implemented (501) |
| POST | `/ingest/traces` | Ingest verified traces | not implemented (501) |
| POST | `/ingest/metrics` | Ingest training metrics | not implemented (501) |

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
