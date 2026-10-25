/** Real component references used by the motor inventory and physics model.
 * Torque values are in N·m. "ratedTorqueNm" is a representative useful operating
 * point; "stallTorqueNm" is an extrapolated short-duration maximum, not a safe
 * continuous load. Some TT data sheets omit a continuous torque rating, so its
 * conservative simulation operating point is explicitly an estimate.
 */
export type MotorVariantId = 'fa130' | 'tt48' | 'n20_100' | '37d_30'
export type MotorItemId = 'motor' | 'motor_tt' | 'motor_n20' | 'motor_37d'

export interface MotorSpec {
  id: MotorVariantId
  itemId: MotorItemId
  name: string
  nominalVoltageV: number
  massKg: number
  noLoadRpm: number
  ratedTorqueNm: number
  stallTorqueNm: number
  /** Approximate stall current in amperes for the DC equivalent-circuit model. */
  stallCurrentA?: number
  gearRatio: string
  description: string
  physicalInfo: string
  currentInfo: string
}

export const MOTOR_SPECS: Record<MotorVariantId, MotorSpec> = {
  fa130: {
    id: 'fa130',
    itemId: 'motor',
    name: 'Motor CC Mabuchi FA-130RA',
    nominalVoltageV: 3,
    massKg: 0.017,
    noLoadRpm: 12300,
    ratedTorqueNm: 0.00074,
    stallTorqueNm: 0.00353,
    stallCurrentA: 2.1,
    gearRatio: '1:1 (sem redução)',
    description: 'Motor CC escovado compacto, sem caixa de redução. Gira muito rápido, mas entrega pouco torque no eixo; indicado para mecanismos leves.',
    physicalInfo: 'Mabuchi FA-130RA-18100 • 3 V • 17 g • 12.300 rpm sem carga • Torque no ponto de máxima eficiência: 0,00074 N·m • Torque de bloqueio: 0,00353 N·m',
    currentInfo: 'Corrente de bloqueio: 2,1 A (valor de catálogo; não é consumo contínuo)',
  },
  tt48: {
    id: 'tt48',
    itemId: 'motor_tt',
    name: 'Motor TT com redução 1:48',
    nominalVoltageV: 6,
    massKg: 0.0306,
    noLoadRpm: 200,
    ratedTorqueNm: 0.0196,
    stallTorqueNm: 0.07845,
    stallCurrentA: 1.5, // approximate; varies widely across inexpensive TT gearbox motors
    gearRatio: '1:48',
    description: 'Motor CC com caixa de redução plástica amarela. A redução diminui a velocidade e aumenta o torque de saída; comum em robótica educacional.',
    physicalInfo: 'Motor TT • 3–6 V • 30,6 g • 200 rpm sem carga a 6 V • Redução 1:48 • Torque de bloqueio: 0,078 N·m',
    currentInfo: 'Corrente sem carga: cerca de 150 mA • Torque de trabalho exibido pelo simulador é uma estimativa conservadora, não uma especificação de catálogo',
  },
  n20_100: {
    id: 'n20_100',
    itemId: 'motor_n20',
    name: 'Micromotor N20 metálico 100:1 HP',
    nominalVoltageV: 6,
    massKg: 0.0095,
    noLoadRpm: 310,
    ratedTorqueNm: 0.02845,
    stallTorqueNm: 0.1667,
    stallCurrentA: 1.6,
    gearRatio: '100,37:1',
    description: 'Micromotor CC com caixa de engrenagens metálica e eixo tipo D. Compacto, com mais força de saída do que um motor sem redução.',
    physicalInfo: 'Referência Pololu 100:1 HP • 6 V • 9,5 g • 310 rpm sem carga • Torque no ponto de máxima eficiência: 0,028 N·m • Torque de bloqueio extrapolado: 0,167 N·m',
    currentInfo: 'Corrente sem carga: cerca de 0,10 A • Corrente de bloqueio: 1,6 A; bloquear o eixo pode danificar motor e caixa',
  },
  '37d_30': {
    id: '37d_30',
    itemId: 'motor_37d',
    name: 'Motorredutor metálico 37D 30:1',
    nominalVoltageV: 12,
    massKg: 0.185,
    noLoadRpm: 330,
    ratedTorqueNm: 0.1765,
    stallTorqueNm: 1.373,
    stallCurrentA: 5.5,
    gearRatio: '30:1',
    description: 'Motor CC de 12 V com caixa de engrenagens metálica, eixo de saída de 6 mm e alto torque. Consome corrente elevada sob carga.',
    physicalInfo: 'Referência Pololu 37D 30:1 • 12 V • 185 g • 330 rpm sem carga • Torque na máxima eficiência: 0,177 N·m • Torque de bloqueio extrapolado: 1,37 N·m',
    currentInfo: 'Corrente sem carga: cerca de 0,20 A • Corrente de bloqueio: 5,5 A; o torque de bloqueio não deve ser mantido continuamente',
  },
}

export const DEFAULT_MOTOR_VARIANT: MotorVariantId = 'fa130'

export function getMotorSpec(id: MotorVariantId | string | null | undefined): MotorSpec {
  return MOTOR_SPECS[id as MotorVariantId] ?? MOTOR_SPECS[DEFAULT_MOTOR_VARIANT]
}

export function isMotorItemId(item: string | null | undefined): item is MotorItemId {
  return item === 'motor' || item === 'motor_tt' || item === 'motor_n20' || item === 'motor_37d'
}

export function motorItemForVariant(id: MotorVariantId | string | null | undefined): MotorItemId {
  return getMotorSpec(id).itemId
}
