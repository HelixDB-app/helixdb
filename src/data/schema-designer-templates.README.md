# Schema Designer Templates

The source of truth for predefined templates is:

- `src/data/schema-designer-templates.json`

## Catalog Structure

```json
{
  "version": 1,
  "updated_at": "YYYY-MM-DD",
  "full_schema_templates": ["..."],
  "module_templates": ["..."]
}
```

Each template object uses:

- `id`: stable unique key (snake_case)
- `name`: display name
- `description`: short purpose text
- `category`: filter grouping
- `tags`: searchable keywords
- `tables`: array of table definitions

Each table uses:

- `name`
- `columns`
- `indexes` (optional)

Each column uses:

- `name`, `data_type`, `nullable`, `default_value`, `is_primary_key`
- optional `unique`
- optional `foreign_key` with `{ "target_table", "target_column" }` using table/column names (not IDs)

Each index uses:

- `name`, `columns` (column names), `unique`, `method`

## Best Practices

- Use lowercase snake_case names for template IDs, table names, and columns.
- Keep module templates focused and composable (small groups of related tables).
- Prefer name-based FK references so runtime ID generation remains automatic.
- Add unique constraints via `unique` on columns or explicit unique indexes.
- Keep descriptions concise for fast UI scanning.
