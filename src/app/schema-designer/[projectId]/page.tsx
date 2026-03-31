import { SchemaDesignerWorkspace } from '@/components/schema-designer/SchemaDesignerWorkspace'

export const dynamicParams = false

export function generateStaticParams() {
  return []
}

export default async function SchemaDesignerProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  return <SchemaDesignerWorkspace projectId={projectId} />
}
