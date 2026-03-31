import type { Table } from '@/lib/schema-store'
import { generateDrizzleExport } from '@/codegen/drizzle'
import { generateGraphQLExport } from '@/codegen/graphql'
import { generatePrismaExport } from '@/codegen/prisma'
import { generatePydanticExport } from '@/codegen/pydantic'
import { generateTypeScriptExport } from '@/codegen/ts'
import { generateZodExport } from '@/codegen/zod'

export type ExportFormat =
  | 'typescript'
  | 'prisma'
  | 'drizzle'
  | 'zod'
  | 'graphql'
  | 'pydantic'

export function generateExport(tables: Table[], format: ExportFormat): string {
  if (tables.length === 0) {
    return '// No tables in this schema.\n'
  }
  switch (format) {
    case 'typescript':
      return generateTypeScriptExport(tables)
    case 'prisma':
      return generatePrismaExport(tables)
    case 'drizzle':
      return generateDrizzleExport(tables)
    case 'zod':
      return generateZodExport(tables)
    case 'graphql':
      return generateGraphQLExport(tables)
    case 'pydantic':
      return generatePydanticExport(tables)
    default:
      return ''
  }
}

export const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = {
  typescript: 'TypeScript',
  prisma: 'Prisma',
  drizzle: 'Drizzle',
  zod: 'Zod',
  graphql: 'GraphQL SDL',
  pydantic: 'Python Pydantic',
}

export function exportFormatFileStem(format: ExportFormat): string {
  switch (format) {
    case 'typescript':
      return 'schema-types'
    case 'prisma':
      return 'schema'
    case 'drizzle':
      return 'schema.drizzle'
    case 'zod':
      return 'schema.zod'
    case 'graphql':
      return 'schema'
    case 'pydantic':
      return 'schema_models'
    default:
      return 'export'
  }
}

export function exportFormatExtension(format: ExportFormat): string {
  switch (format) {
    case 'prisma':
      return 'prisma'
    case 'graphql':
      return 'graphql'
    case 'pydantic':
      return 'py'
    default:
      return 'ts'
  }
}

export * from '@/codegen/column-utils'
