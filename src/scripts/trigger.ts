/**
 * Manual trigger: corre el `perDealWorkflow` sobre un deal específico sin
 * esperar al cron ni tocar `proximo_intento_fecha`.
 *
 * Uso:
 *   npm run trigger -- --deal=12345
 *   npm run trigger -- --deal=12345 --approve     # bypassa approval queue
 *   SMOKE_REAL_SEND=true npm run trigger -- --deal=12345  # send real
 *
 * Default: APPROVAL_MODE=off, STUB_SEND=true (HubSpot real, mensajes stub).
 * Setear SMOKE_REAL_SEND=true para mandar de verdad.
 */

// IMPORTANTE: setear env vars ANTES de importar mastra (CONFIG/STUB_MODE leen al import).
process.env.STUB_MODE = process.env.STUB_MODE ?? 'false';
if (!process.argv.includes('--keep-approval-on')) {
  process.env.APPROVAL_MODE = 'off';
}
if (process.env.SMOKE_REAL_SEND !== 'true') {
  process.env.STUB_SEND = 'true';
}

function getArg(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const dealId = getArg('--deal');
  if (!dealId) {
    console.error('Uso: npm run trigger -- --deal=<dealId>');
    process.exit(1);
  }

  if (process.env.SMOKE_REAL_SEND === 'true') {
    console.warn(`⚠ SMOKE_REAL_SEND=true — el trigger MANDARÁ un mensaje real al deal ${dealId}.`);
  } else {
    console.log(`· STUB_SEND=true (mensajes stub). HubSpot ${process.env.STUB_MODE === 'true' ? 'STUB' : 'REAL'}.`);
  }

  // Import dinámico DESPUÉS del setup de env.
  const { mastra } = await import('../mastra/index.js');
  const { getDealContextTool } = await import('../mastra/tools/hubspot-tools.js');
  const { isValidationError } = await import('@mastra/core/tools');

  console.log(`\n[1/3] Cargando deal ${dealId}...`);
  const ctx = await getDealContextTool.execute!(
    { dealId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { mastra } as any,
  );
  if (isValidationError(ctx)) {
    console.error('Validation error cargando deal:', ctx.message);
    process.exit(2);
  }
  console.log(`  contact: ${(ctx as { contact: { firstname: string | null; company: string | null } }).contact.firstname ?? '?'} (${(ctx as { contact: { company: string | null } }).contact.company ?? '?'})`);

  console.log('\n[2/3] Triggering perDealWorkflow...');
  const wf = mastra.getWorkflow('perDealWorkflow');
  if (!wf) {
    console.error('perDealWorkflow no registrado.');
    process.exit(2);
  }
  const run = await wf.createRun();
  const t0 = Date.now();
  // El cast es necesario porque getDealContextTool retorna `unknown` cuando lo invocamos
  // a mano (sin pasar por el step framework de Mastra que valida con Zod).
  const result = await run.start({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputData: { deal: (ctx as { deal: any }).deal },
  });
  const elapsed = Date.now() - t0;

  console.log(`\n[3/3] Resultado (${elapsed}ms)`);
  console.log(`  status:   ${result.status}`);
  if (result.status === 'success' && result.result) {
    const r = result.result as {
      dealId?: string;
      actionType?: string;
      outcome?: string;
      messageId?: string | null;
      reason?: string;
    };
    console.log(`  outcome:  ${r.outcome}`);
    console.log(`  action:   ${r.actionType}`);
    if (r.messageId) console.log(`  msgId:    ${r.messageId}`);
    if (r.reason) console.log(`  reason:   ${r.reason}`);
  } else if (result.status === 'failed') {
    console.error('  error:', result.error);
  }

  if (mastra.shutdown) await mastra.shutdown();
  process.exit(result.status === 'success' ? 0 : 1);
}

main().catch((err) => {
  console.error('trigger crash:', err);
  process.exit(2);
});
