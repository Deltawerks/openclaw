import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isSecretRefObject } from "../../components/config-form.node.shared.ts";
import { t } from "../../i18n/index.ts";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";

/** Sensitive containers are refused whole before JSON serialization. */
export function formatPluginHelpValue(value: unknown, sensitive: boolean): string {
  if (sensitive) {
    return "<redacted>";
  }
  const pending = [value];
  let scanned = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (++scanned > 1000 || entry === REDACTED_SENTINEL || isSecretRefObject(entry)) {
      return "<redacted>";
    }
    if (entry && typeof entry === "object") {
      const entries = Object.values(entry);
      if (entries.length + pending.length + scanned > 1000) {
        return "<redacted>";
      }
      pending.push(...entries);
    }
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined
    ? t("custodian.pluginHelpUnset")
    : text.length > 512
      ? `${truncateUtf16Safe(text, 512)}…`
      : text;
}
