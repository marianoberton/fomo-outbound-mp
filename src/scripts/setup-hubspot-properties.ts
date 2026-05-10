/**
 * Crea idempotentemente las propiedades custom de Deal y Contact que el agente necesita.
 * Re-correr es seguro: si la propiedad ya existe, se saltea con log.
 *
 * Uso:
 *   HUBSPOT_PRIVATE_APP_TOKEN=... npm run setup:hubspot
 *
 * Refs: MP.md §4.
 */
import { Client } from '@hubspot/api-client';

type PropertyDef = {
  name: string;
  label: string;
  description: string;
  type: 'enumeration' | 'number' | 'date' | 'string' | 'bool';
  fieldType: 'select' | 'radio' | 'number' | 'date' | 'text' | 'textarea' | 'booleancheckbox';
  options?: Array<{ label: string; value: string; displayOrder: number; hidden?: boolean }>;
};

const DEAL_GROUP = 'dealinformation';
const CONTACT_GROUP = 'contactinformation';

const DEAL_PROPS: PropertyDef[] = [
  {
    name: 'reactivacion_estado',
    label: 'Reactivación: estado',
    description: 'Estado del deal en la cadencia de reactivación outbound.',
    type: 'enumeration',
    fieldType: 'select',
    options: [
      'eligible',
      'sent_attempt_1',
      'sent_attempt_2',
      'sent_attempt_3',
      'awaiting_response',
      'active_conversation',
      'awaiting_lost_confirmation',
      'frozen',
      'won',
      'lost',
      'excluded',
    ].map((v, i) => ({ label: v, value: v, displayOrder: i })),
  },
  {
    name: 'intento_n',
    label: 'Reactivación: intento N',
    description: 'Cantidad de intentos de contacto enviados (0-3).',
    type: 'number',
    fieldType: 'number',
  },
  {
    name: 'ultimo_intento_fecha',
    label: 'Reactivación: último intento',
    description: 'Fecha del último mensaje enviado por el agente.',
    type: 'date',
    fieldType: 'date',
  },
  {
    name: 'ultimo_intento_canal',
    label: 'Reactivación: canal último intento',
    description: 'Canal usado en el último intento.',
    type: 'enumeration',
    fieldType: 'select',
    options: [
      { label: 'email', value: 'email', displayOrder: 0 },
      { label: 'whatsapp', value: 'whatsapp', displayOrder: 1 },
    ],
  },
  {
    name: 'proximo_intento_fecha',
    label: 'Reactivación: próximo intento',
    description: 'Fecha en que el cron procesará este deal de nuevo.',
    type: 'date',
    fieldType: 'date',
  },
  {
    name: 'canal_original',
    label: 'Reactivación: canal original',
    description: 'Canal por el que entró el deal originalmente.',
    type: 'enumeration',
    fieldType: 'select',
    options: [
      { label: 'email', value: 'email', displayOrder: 0 },
      { label: 'whatsapp', value: 'whatsapp', displayOrder: 1 },
      { label: 'manychat', value: 'manychat', displayOrder: 2 },
      { label: 'form', value: 'form', displayOrder: 3 },
    ],
  },
  {
    name: 'semaforo_cotizacion',
    label: 'Reactivación: semáforo cotización',
    description: 'Verde = precio competitivo, amarillo = medio, rojo = alto.',
    type: 'enumeration',
    fieldType: 'select',
    options: [
      { label: 'verde', value: 'verde', displayOrder: 0 },
      { label: 'amarillo', value: 'amarillo', displayOrder: 1 },
      { label: 'rojo', value: 'rojo', displayOrder: 2 },
    ],
  },
  {
    name: 'monto_cotizado_ars',
    label: 'Reactivación: monto cotizado (ARS)',
    description: 'Monto cotizado en pesos argentinos. Umbral grande/chico.',
    type: 'number',
    fieldType: 'number',
  },
  {
    name: 'pdf_presupuesto_url',
    label: 'Reactivación: URL PDF presupuesto',
    description: 'Link público al PDF del presupuesto enviado.',
    type: 'string',
    fieldType: 'text',
  },
  {
    name: 'intentos_fallidos',
    label: 'Reactivación: intentos fallidos consecutivos',
    description:
      'Cuántas veces falló el workflow sobre este deal en runs consecutivos. Si llega al umbral, el deal se excluye automáticamente para evitar loops infinitos.',
    type: 'number',
    fieldType: 'number',
  },
];

const CONTACT_PROPS: PropertyDef[] = [
  {
    name: 'no_contactar',
    label: 'No contactar',
    description: 'Si el contact pidió explícitamente no recibir más mensajes.',
    type: 'bool',
    fieldType: 'booleancheckbox',
  },
  {
    name: 'no_contactar_motivo',
    label: 'Motivo no contactar',
    description: 'Texto libre con la razón. Lo carga el agente o un humano.',
    type: 'string',
    fieldType: 'textarea',
  },
  {
    name: 'wa_last_inbound_at',
    label: 'WhatsApp: último inbound',
    description:
      'ISO timestamp del último mensaje inbound del cliente. Lo usa el agente para chequear la ventana de 24h antes de enviar texto libre por WhatsApp.',
    type: 'string',
    fieldType: 'text',
  },
];

async function ensureProperty(
  client: Client,
  objectType: 'deals' | 'contacts',
  group: string,
  prop: PropertyDef,
): Promise<'created' | 'exists'> {
  try {
    await client.crm.properties.coreApi.getByName(objectType, prop.name);
    return 'exists';
  } catch (err) {
    const status = (err as { code?: number; status?: number })?.code;
    if (status !== 404) throw err;
  }

  await client.crm.properties.coreApi.create(objectType, {
    name: prop.name,
    label: prop.label,
    description: prop.description,
    type: prop.type,
    fieldType: prop.fieldType,
    groupName: group,
    options: prop.options ?? [],
  } as never);
  return 'created';
}

async function main(): Promise<void> {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) {
    console.error('HUBSPOT_PRIVATE_APP_TOKEN no está seteado.');
    process.exit(1);
  }
  const client = new Client({ accessToken: token });

  console.log('--- Deal properties ---');
  for (const p of DEAL_PROPS) {
    try {
      const result = await ensureProperty(client, 'deals', DEAL_GROUP, p);
      console.log(`  ${p.name}: ${result}`);
    } catch (err) {
      const msg = (err as Error)?.message ?? err;
      console.error(`  ${p.name}: ERROR — ${msg}`);
    }
  }

  console.log('--- Contact properties ---');
  for (const p of CONTACT_PROPS) {
    try {
      const result = await ensureProperty(client, 'contacts', CONTACT_GROUP, p);
      console.log(`  ${p.name}: ${result}`);
    } catch (err) {
      const msg = (err as Error)?.message ?? err;
      console.error(`  ${p.name}: ERROR — ${msg}`);
    }
  }

  console.log('Listo.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
