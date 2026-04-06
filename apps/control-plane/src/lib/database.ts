import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { AppConfig } from "../config.js";

export type QueryResultRow = Record<string, unknown>;
export type QueryParam = SQLInputValue;

export interface QueryResult<TRow extends QueryResultRow = QueryResultRow> {
  rowCount: number;
  rows: TRow[];
}

export interface Queryable {
  exec(sql: string): Promise<void>;
  query<TRow extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly QueryParam[],
  ): Promise<QueryResult<TRow>>;
}

export interface Database extends Queryable {
  ping(): Promise<void>;
  close(): Promise<void>;
  transaction<TResult>(operation: (client: Queryable) => Promise<TResult>): Promise<TResult>;
}

function hasResultRows(sql: string): boolean {
  const normalized = sql.trim().toLowerCase();
  return normalized.startsWith("select") || normalized.startsWith("with") || normalized.startsWith("pragma") || normalized.includes(" returning ");
}

function createQueryable(database: DatabaseSync): Queryable {
  return {
    async exec(sql: string): Promise<void> {
      database.exec(sql);
    },

    async query<TRow extends QueryResultRow = QueryResultRow>(
      text: string,
      params: readonly QueryParam[] = [],
    ): Promise<QueryResult<TRow>> {
      const statement = database.prepare(text);

      if (hasResultRows(text)) {
        const rows = statement.all(...params) as TRow[];
        return {
          rowCount: rows.length,
          rows,
        };
      }

      const result = statement.run(...params);
      return {
        rowCount: Number(result.changes ?? 0),
        rows: [],
      };
    },
  };
}

export function createDatabase(config: AppConfig): Database {
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const database = new DatabaseSync(config.databasePath);
  database.exec("pragma foreign_keys = on;");
  database.exec("pragma journal_mode = wal;");

  const queryable = createQueryable(database);

  return {
    ...queryable,

    async ping(): Promise<void> {
      database.prepare("select 1 as ok").get();
    },

    async close(): Promise<void> {
      database.close();
    },

    async transaction<TResult>(operation: (client: Queryable) => Promise<TResult>): Promise<TResult> {
      database.exec("begin immediate transaction");

      try {
        const result = await operation(queryable);
        database.exec("commit");
        return result;
      } catch (error) {
        database.exec("rollback");
        throw error;
      }
    },
  };
}
