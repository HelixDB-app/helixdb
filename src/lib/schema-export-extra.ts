/**
 * Additional codegen targets for the AI schema designer export menu.
 */

import type { Relationship, SchemaFunction, SchemaTrigger, Table } from '@/lib/schema-store'
import { generateSQL } from '@/lib/sql-export'

function pascal(s: string): string {
  return s.replace(/(^|_)([a-z])/g, (_, _a, b) => String(b).toUpperCase()).replace(/_/g, '')
}

function prismaFieldType(col: Table['columns'][number]): string {
  switch (col.type) {
    case 'integer':
      return 'Int'
    case 'numeric':
      return 'Decimal @db.Decimal(18, 4)'
    case 'boolean':
      return 'Boolean'
    case 'timestamp':
      return 'DateTime'
    case 'uuid':
      return 'String @db.Uuid'
    case 'json':
      return 'Json'
    case 'text':
      return 'String @db.Text'
    default:
      return 'String'
  }
}

export function generatePrismaSchema(tables: Table[]): string {
  const head = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

`
  const models = tables.map((t) => {
    const lines = [`model ${pascal(t.name)} {`]
    for (const c of t.columns) {
      let line = `  ${c.name} ${prismaFieldType(c)}`
      if (c.isPrimaryKey) line += ' @id'
      if (!c.nullable && !c.isPrimaryKey) line += ''
      if (c.isUnique && !c.isPrimaryKey) line += ' @unique'
      if (c.nullable) line += '?'
      lines.push(line)
    }
    lines.push('}')
    return lines.join('\n')
  })
  return head + models.join('\n\n')
}

export function generateTypeOrmEntities(tables: Table[]): string {
  return tables
    .map((t) => {
      const cols = t.columns
        .map((c) => {
          const ts =
            c.type === 'integer'
              ? 'number'
              : c.type === 'numeric'
                ? 'number'
                : c.type === 'boolean'
                  ? 'boolean'
                  : c.type === 'timestamp'
                    ? 'Date'
                    : 'string'
          const deco = c.isPrimaryKey ? '@PrimaryColumn()\n  ' : '@Column()\n  '
          return `  ${deco}${c.name}!: ${ts}`
        })
        .join('\n')
      return `@Entity('${t.name}')\nexport class ${pascal(t.name)} {\n${cols}\n}`
    })
    .join('\n\n')
}

export function generateSequelizeModels(tables: Table[]): string {
  const out: string[] = []
  out.push(`import { DataTypes, Model } from 'sequelize'`)
  for (const t of tables) {
    out.push(
      `\nexport const ${pascal(t.name)}Model = {\n  tableName: '${t.name}',\n  columns: {`
    )
    for (const c of t.columns) {
      const st =
        c.type === 'integer'
          ? 'DataTypes.INTEGER'
          : c.type === 'boolean'
            ? 'DataTypes.BOOLEAN'
            : c.type === 'timestamp'
              ? 'DataTypes.DATE'
              : c.type === 'uuid'
                ? 'DataTypes.UUID'
                : 'DataTypes.STRING'
      out.push(`    ${c.name}: { type: ${st}, allowNull: ${c.nullable}, primaryKey: ${c.isPrimaryKey} },`)
    }
    out.push('  },\n}')
  }
  return out.join('\n')
}

const PG_TO_MYSQL: Record<string, string> = {
  STRING: 'VARCHAR(255)',
  INTEGER: 'INT',
  NUMERIC: 'DECIMAL(18,4)',
  BOOLEAN: 'BOOLEAN',
  TEXT: 'TEXT',
  TIMESTAMP: 'DATETIME(6)',
  UUID: 'CHAR(36)',
  JSON: 'JSON',
}

export function generateMysqlDDL(
  tables: Table[],
  relationships: Relationship[],
  functions: SchemaFunction[] = [],
  triggers: SchemaTrigger[] = []
): string {
  const raw = generateSQL(tables, relationships, functions, triggers)
  return raw.replace(/\b(UUID|STRING|INTEGER|NUMERIC|BOOLEAN|TEXT|TIMESTAMP|JSON)\b/g, (m) => {
    return PG_TO_MYSQL[m] ?? m
  })
}

export function generateJsonSchemaTables(tables: Table[]): string {
  const schemas = tables.map((t) => {
    const props: Record<string, unknown> = {}
    const required: string[] = []
    for (const c of t.columns) {
      let ty = 'string'
      if (c.type === 'integer' || c.type === 'numeric') ty = 'number'
      if (c.type === 'boolean') ty = 'boolean'
      if (c.type === 'json') ty = 'object'
      props[c.name] = { type: ty }
      if (!c.nullable) required.push(c.name)
    }
    return {
      $id: `https://schema.local/${t.name}`,
      type: 'object',
      title: t.name,
      properties: props,
      required,
    }
  })
  return JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', tables: schemas }, null, 2)
}
