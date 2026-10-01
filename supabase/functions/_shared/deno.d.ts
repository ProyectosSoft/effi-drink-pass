// Declaraciones mínimas de Deno para chequear tipos desde Node (tsconfig.functions.json).
// En el runtime real de Supabase Edge Functions estos globals los provee Deno.
declare namespace Deno {
  const env: { get(key: string): string | undefined }
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown
}
