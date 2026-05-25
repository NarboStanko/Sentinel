// Design system — calmo, pulito, affidabile. Una palette sobria con un accento
// verde-salvia (sicuro), ambra (battito in attesa) e rosso solo per il rilascio.
export const colors = {
  bg: '#F6F4EF',          // off-white caldo
  surface: '#FFFFFF',
  surfaceAlt: '#EFEDE6',
  ink: '#1B1D1A',         // testo primario
  inkDim: '#5C5F58',      // testo secondario
  inkFaint: '#9A9D94',
  line: '#E2DFD6',
  safe: '#3E8E72',        // armato / tutto ok
  safeSoft: '#E4F0EA',
  heartbeat: '#C8881F',   // check in attesa
  heartbeatSoft: '#F7EBD3',
  danger: '#C0492F',      // trigger / rilascio
  dangerSoft: '#F6E3DD',
  accent: '#2F6F5E',
};
export const radius = { sm: 8, md: 14, lg: 20, pill: 999 };
export const space = (n: number) => n * 4; // 4pt grid
export const type = {
  display: { fontSize: 30, fontWeight: '700' as const, letterSpacing: -0.4, color: colors.ink },
  title: { fontSize: 22, fontWeight: '600' as const, color: colors.ink },
  heading: { fontSize: 17, fontWeight: '600' as const, color: colors.ink },
  body: { fontSize: 16, fontWeight: '400' as const, color: colors.ink, lineHeight: 24 },
  dim: { fontSize: 14, fontWeight: '400' as const, color: colors.inkDim, lineHeight: 21 },
  mono: { fontSize: 14, fontFamily: 'Courier', color: colors.ink },
  label: { fontSize: 12, fontWeight: '600' as const, letterSpacing: 1, color: colors.inkFaint },
};
