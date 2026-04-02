/** Preset prompts for the AI Schema home page (template library). */

export const SCHEMA_TEMPLATES: { id: string; title: string; prompt: string }[] = [
  {
    id: 'ecommerce',
    title: 'E-commerce',
    prompt:
      'Design a production-ready e-commerce schema: customers, addresses, products, categories, carts, orders, order lines, payments, inventory, and promotions. Include audit columns and indexes on foreign keys.',
  },
  {
    id: 'blog',
    title: 'Blog',
    prompt:
      'Multi-author blog: users, posts, tags, comments, media assets, and SEO metadata. Support soft deletes and slug uniqueness.',
  },
  {
    id: 'saas',
    title: 'SaaS multi-tenant',
    prompt:
      'B2B SaaS with organizations, members, roles, subscriptions, invoices, API keys, audit logs, and feature flags. Tenant_id on all org-scoped tables.',
  },
  {
    id: 'social',
    title: 'Social network',
    prompt:
      'Social app: profiles, follows, posts, reactions, comments, notifications, and direct messages. Optimize for read-heavy timelines.',
  },
  {
    id: 'healthcare',
    title: 'Healthcare',
    prompt:
      'HIPAA-oriented patient management: providers, patients, appointments, clinical notes (minimal PHI in schema names), prescriptions, and billing links. Strong audit trail.',
  },
  {
    id: 'finance',
    title: 'Finance / ledger',
    prompt:
      'Double-entry ledger: accounts, journal entries, transactions, categories, recurring rules, and reconciliation snapshots. Immutable posting lines.',
  },
]
