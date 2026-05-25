import React from 'react';
import { Text, View, Pressable, StyleSheet, ViewStyle, ScrollView } from 'react-native';
import { colors, radius, space, type } from '../theme';

export function Screen({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: space(6), paddingTop: space(14), paddingBottom: space(16), gap: space(4) }}>
      {children}
    </ScrollView>
  );
}

export function Card({ children, tone = 'surface', style }: { children: React.ReactNode; tone?: 'surface' | 'safe' | 'heartbeat' | 'danger'; style?: ViewStyle }) {
  const bg = { surface: colors.surface, safe: colors.safeSoft, heartbeat: colors.heartbeatSoft, danger: colors.dangerSoft }[tone];
  return <View style={[styles.card, { backgroundColor: bg }, style]}>{children}</View>;
}

export function Button({ label, onPress, variant = 'primary', disabled }: { label: string; onPress?: () => void; variant?: 'primary' | 'ghost' | 'safe' | 'danger'; disabled?: boolean }) {
  const bg = { primary: colors.ink, safe: colors.safe, danger: colors.danger, ghost: 'transparent' }[variant];
  const fg = variant === 'ghost' ? colors.ink : '#FFFFFF';
  return (
    <Pressable onPress={onPress} disabled={disabled}
      style={({ pressed }) => [styles.btn, { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.85 : 1, borderWidth: variant === 'ghost' ? 1 : 0, borderColor: colors.line }]}>
      <Text style={{ color: fg, fontSize: 16, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

export function Pill({ label, tone = 'safe' }: { label: string; tone?: 'safe' | 'heartbeat' | 'danger' | 'neutral' }) {
  const map = { safe: [colors.safeSoft, colors.safe], heartbeat: [colors.heartbeatSoft, colors.heartbeat], danger: [colors.dangerSoft, colors.danger], neutral: [colors.surfaceAlt, colors.inkDim] }[tone];
  return <View style={{ alignSelf: 'flex-start', backgroundColor: map[0], paddingHorizontal: space(3), paddingVertical: space(1.5), borderRadius: radius.pill }}>
    <Text style={{ color: map[1], fontSize: 12, fontWeight: '700', letterSpacing: 1 }}>{label}</Text>
  </View>;
}

export const T = { ...type };
const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: space(5), gap: space(3) },
  btn: { borderRadius: radius.md, paddingVertical: space(4), alignItems: 'center', justifyContent: 'center' },
});
