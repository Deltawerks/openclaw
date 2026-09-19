---
summary: "Use TypeSafe's Jev model for optional typed judgments"
title: "TypeSafe"
read_when:
  - Configuring a typed judgment provider
  - Using the TypeSafe evaluation tool
---

# TypeSafe

The bundled `typesafe` plugin connects OpenClaw's optional judgment capability
to TypeSafe's Jev model. It is not a conversational model provider and does not
appear in the chat model picker.

The plugin is disabled by default. Bundling it does not authorize requests,
select a judgment provider, or schedule background work.

## Enable and configure

Create a protected credential in Settings → Secrets, then reference it from
the plugin configuration. Merge this example into your existing configuration;
keep any other entries in `plugins.allow`.

```json5
{
  plugins: {
    allow: ["typesafe"],
    entries: {
      typesafe: {
        enabled: true,
        config: {
          apiKey: { source: "store", provider: "default", id: "TYPESAFE_API_KEY" },
          model: "jev-latest",
        },
      },
    },
  },
  judgments: { provider: "typesafe" },
}
```

The plugin uses the host's prepared SecretRef value, not a separately read
environment variable or a cached copy of a previous credential. A missing or
unavailable credential makes judgments unavailable. Use the normal
[secret refresh flow](/gateway/secrets) after changing a credential.

Selecting the provider authorizes supported, otherwise-enabled consumers to
send their selected evidence to TypeSafe and incur its normal usage charges.
Consumer scheduling and publication permissions remain unchanged. Remove
`judgments.provider` to stop selecting the provider; explicitly disabling the
plugin also prevents its use.

## Judgment contract

Consumers call the provider-neutral
[judgment runtime](/plugins/sdk-overview/capabilities#typed-judgments-contract-version-1).
The adapter translates the supported question types:

| OpenClaw | TypeSafe | Result                                                          |
| -------- | -------- | --------------------------------------------------------------- |
| Choice   | Choice   | Selected label and probability distribution                     |
| Score    | Score    | Fractional expected zero-based rubric position and distribution |
| Boolean  | Noul     | Probability of true, preserved as a number from 0 to 1          |

Choice supports 2–255 alternatives; Score supports 2–10 rubric levels.
Unsupported input is rejected before transmission; the adapter does not
truncate or split a consumer's rubric. The host and adapter validate complete
responses, including consistency between a selected choice and its probabilities.
Probabilities are not a demonstrated accuracy guarantee.

The host owns concurrency, circuit health, deadlines, cancellation, and provider
lifecycle. The adapter shares transport and response validation with the tool
below. Neither surface retries requests automatically. Consumers decide what to
do with unavailable judgments; cancellation must not start fallback work.

## Optional evaluation tool

The same plugin registers the optional `typesafe_evaluate` tool. Enable it through
your normal [tool policy](/tools) when an agent should make explicit evaluations.
It accepts shared `state`, a map of `questions`, and an optional `model` override.
Its TypeSafe-facing question names are `choice`, `score`, and `noul`.

Tool availability and `judgments.provider` are separate: an explicitly enabled
tool does not select a background provider, and selecting a provider does not
grant agents the tool. Typed answers supply evidence, not authority to publish,
send messages, or change durable state.

## Existing external installation

This bundled plugin uses the same `typesafe` plugin ID as the external prototype.
Do not configure two installations as independent providers. Inspect plugin
resolution before switching, preserve the existing configuration and credential,
and use the supported [plugin management flow](/plugins/manage-plugins) to remove
an external override if you want the bundled copy to own the ID. Installing this
change does not delete external plugin files or credentials.
