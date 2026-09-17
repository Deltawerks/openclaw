import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashSqliteSchema(database: DatabaseSync): string {
  const schema = database
    .prepare(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    )
    .all();
  return sha256(JSON.stringify(schema));
}
