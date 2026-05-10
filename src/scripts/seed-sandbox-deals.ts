/**
 * Crea 5 deals fake en el sandbox de HubSpot, cada uno en un estado distinto de la cadencia.
 *
 * Estados sembrados (MP.md §13):
 *   1. fresh           — intento 0, 5d en seguimiento
 *   2. revival         — intento 0, 21d en seguimiento
 *   3. intento1-enviado — intento 1, ult. canal email
 *   4. intento2-enviado — intento 2, ult. canal whatsapp
 *   5. intento3-pendiente — intento 3, listo para freeze (>5M ARS) o propose-lost
 *
 * Uso:
 *   npm run seed:sandbox
 *
 * Pre-requisitos:
 *   - HUBSPOT_PRIVATE_APP_TOKEN, HUBSPOT_PIPELINE_MAYORISTA_ID, HUBSPOT_STAGE_SEGUIMIENTO_ID seteados
 *   - Las propiedades custom existen (correr `npm run setup:hubspot` primero)
 */
import { Client } from '@hubspot/api-client';

type DealSeed = {
  label: string;
  contact: {
    firstname: string;
    lastname: string;
    company: string;
    email: string;
    phone: string;
  };
  deal: {
    dealname: string;
    amount: number;
    intento_n: number;
    canal_original: 'email' | 'whatsapp';
    semaforo_cotizacion: 'verde' | 'amarillo' | 'rojo';
    monto_cotizado_ars: number;
    pdf_presupuesto_url: string;
    reactivacion_estado: string;
    ultimo_intento_canal: 'email' | 'whatsapp' | null;
    daysInSeguimiento: number; // para calcular proximo_intento_fecha
  };
};

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const SEEDS: DealSeed[] = [
  {
    label: 'fresh',
    contact: {
      firstname: 'Ana',
      lastname: 'Fresh',
      company: 'Lab Fresh SA',
      email: 'ana.fresh+seed@example.com',
      phone: '+5491100000001',
    },
    deal: {
      dealname: '[SEED] Cajas lab — Fresh',
      amount: 1_200_000,
      intento_n: 0,
      canal_original: 'email',
      semaforo_cotizacion: 'verde',
      monto_cotizado_ars: 1_200_000,
      pdf_presupuesto_url: 'https://example.com/presupuesto-fresh.pdf',
      reactivacion_estado: 'eligible',
      ultimo_intento_canal: null,
      daysInSeguimiento: 5,
    },
  },
  {
    label: 'revival',
    contact: {
      firstname: 'Bruno',
      lastname: 'Revival',
      company: 'Industrias Revival',
      email: 'bruno.revival+seed@example.com',
      phone: '+5491100000002',
    },
    deal: {
      dealname: '[SEED] Cajas industriales — Revival',
      amount: 2_500_000,
      intento_n: 0,
      canal_original: 'whatsapp',
      semaforo_cotizacion: 'amarillo',
      monto_cotizado_ars: 2_500_000,
      pdf_presupuesto_url: 'https://example.com/presupuesto-revival.pdf',
      reactivacion_estado: 'eligible',
      ultimo_intento_canal: null,
      daysInSeguimiento: 21,
    },
  },
  {
    label: 'intento1-enviado',
    contact: {
      firstname: 'Carla',
      lastname: 'Intento1',
      company: 'Lab Carla',
      email: 'carla.intento1+seed@example.com',
      phone: '+5491100000003',
    },
    deal: {
      dealname: '[SEED] Cajas — Intento 1 enviado',
      amount: 800_000,
      intento_n: 1,
      canal_original: 'email',
      semaforo_cotizacion: 'verde',
      monto_cotizado_ars: 800_000,
      pdf_presupuesto_url: 'https://example.com/presupuesto-int1.pdf',
      reactivacion_estado: 'sent_attempt_1',
      ultimo_intento_canal: 'email',
      daysInSeguimiento: 18,
    },
  },
  {
    label: 'intento2-enviado',
    contact: {
      firstname: 'Diego',
      lastname: 'Intento2',
      company: 'Distribuidora Diego',
      email: 'diego.intento2+seed@example.com',
      phone: '+5491100000004',
    },
    deal: {
      dealname: '[SEED] Cajas — Intento 2 enviado',
      amount: 3_200_000,
      intento_n: 2,
      canal_original: 'whatsapp',
      semaforo_cotizacion: 'amarillo',
      monto_cotizado_ars: 3_200_000,
      pdf_presupuesto_url: 'https://example.com/presupuesto-int2.pdf',
      reactivacion_estado: 'sent_attempt_2',
      ultimo_intento_canal: 'whatsapp',
      daysInSeguimiento: 28,
    },
  },
  {
    label: 'intento3-pendiente',
    contact: {
      firstname: 'Eva',
      lastname: 'Intento3',
      company: 'Eva Pharma',
      email: 'eva.intento3+seed@example.com',
      phone: '+5491100000005',
    },
    deal: {
      dealname: '[SEED] Cajas — Intento 3 pendiente cierre',
      amount: 7_500_000,
      intento_n: 3,
      canal_original: 'email',
      semaforo_cotizacion: 'rojo',
      monto_cotizado_ars: 7_500_000, // > 5M → freeze
      pdf_presupuesto_url: 'https://example.com/presupuesto-int3.pdf',
      reactivacion_estado: 'sent_attempt_3',
      ultimo_intento_canal: 'email',
      daysInSeguimiento: 35,
    },
  },
];

async function findOrCreateContact(
  client: Client,
  c: DealSeed['contact'],
): Promise<string> {
  // Buscar por email primero (idempotencia).
  try {
    const search = await client.crm.contacts.searchApi.doSearch({
      filterGroups: [
        {
          filters: [{ propertyName: 'email', operator: 'EQ', value: c.email }],
        },
      ],
      properties: ['email'],
      limit: 1,
    } as never);
    if (search.results.length > 0) {
      return search.results[0].id;
    }
  } catch (err) {
    // continuar y crear
  }

  const created = await client.crm.contacts.basicApi.create({
    properties: {
      firstname: c.firstname,
      lastname: c.lastname,
      company: c.company,
      email: c.email,
      phone: c.phone,
    },
  } as never);
  return created.id;
}

async function findExistingSeedDeal(
  client: Client,
  dealname: string,
  contactId: string,
): Promise<string | null> {
  try {
    const res = await client.crm.deals.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            { propertyName: 'dealname', operator: 'EQ', value: dealname },
            { propertyName: 'associations.contact', operator: 'EQ', value: contactId },
          ],
        },
      ],
      properties: ['dealname'],
      limit: 1,
    } as never);
    return res.results[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function createDealForSeed(
  client: Client,
  seed: DealSeed,
  contactId: string,
  pipelineId: string,
  stageId: string,
): Promise<string> {
  const { deal } = seed;
  const ultimoIntentoFecha = deal.intento_n > 0 ? dateNDaysAgo(5) : null;

  const properties: Record<string, string> = {
    dealname: deal.dealname,
    amount: String(deal.amount),
    pipeline: pipelineId,
    dealstage: stageId,
    reactivacion_estado: deal.reactivacion_estado,
    intento_n: String(deal.intento_n),
    canal_original: deal.canal_original,
    semaforo_cotizacion: deal.semaforo_cotizacion,
    monto_cotizado_ars: String(deal.monto_cotizado_ars),
    pdf_presupuesto_url: deal.pdf_presupuesto_url,
    proximo_intento_fecha: todayIso(),
  };
  if (ultimoIntentoFecha) properties.ultimo_intento_fecha = ultimoIntentoFecha;
  if (deal.ultimo_intento_canal) properties.ultimo_intento_canal = deal.ultimo_intento_canal;

  const created = await client.crm.deals.basicApi.create({
    properties,
    associations: [
      {
        to: { id: contactId },
        // 3 = contact_to_deal default association
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
      },
    ],
  } as never);
  return created.id;
}

async function main(): Promise<void> {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  const pipelineId = process.env.HUBSPOT_PIPELINE_MAYORISTA_ID;
  const stageId = process.env.HUBSPOT_STAGE_SEGUIMIENTO_ID;

  if (!token) {
    console.error('HUBSPOT_PRIVATE_APP_TOKEN no está seteado.');
    process.exit(1);
  }
  if (!pipelineId || !stageId) {
    console.error('HUBSPOT_PIPELINE_MAYORISTA_ID o HUBSPOT_STAGE_SEGUIMIENTO_ID no seteados.');
    process.exit(1);
  }

  const client = new Client({ accessToken: token });

  for (const seed of SEEDS) {
    try {
      const contactId = await findOrCreateContact(client, seed.contact);
      const existing = await findExistingSeedDeal(client, seed.deal.dealname, contactId);
      if (existing) {
        console.log(`= ${seed.label}: deal ${existing} ya existía — skip`);
        continue;
      }
      const dealId = await createDealForSeed(client, seed, contactId, pipelineId, stageId);
      console.log(`✔ ${seed.label}: deal ${dealId} (contact ${contactId})`);
    } catch (err) {
      console.error(`✗ ${seed.label}: ${(err as Error).message}`);
    }
  }
  console.log('Listo.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
