import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { COLORS } from '../utils/constants';
import {
  PREVIEW_DEFAULT_ORIGIN,
  getConfiguredPreviewOrigin,
  saveConfiguredPreviewOrigin,
  testPreviewOrigin,
} from '../utils/apiEndpointConfig';
import { normalizePreviewOrigin } from '../utils/previewEndpoint.mjs';

export default function PreviewServerScreen({ initialSetup = false }) {
  const [value, setValue] = useState('');
  const [activeOrigin, setActiveOrigin] = useState(null);
  const [testedOrigin, setTestedOrigin] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getConfiguredPreviewOrigin()
      .then((configured) => {
        if (cancelled) return;
        setActiveOrigin(configured);
        setValue(configured || PREVIEW_DEFAULT_ORIGIN || '');
      })
      .catch(() => {
        if (!cancelled) setStatus({ ok: false, message: 'Could not read the saved Preview server.' });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const onChange = (text) => {
    setValue(text);
    setTestedOrigin(null);
    setStatus(null);
  };

  const testConnection = async () => {
    setTesting(true);
    setTestedOrigin(null);
    setStatus({ ok: null, message: 'Testing the read-only health endpoint…' });
    const result = await testPreviewOrigin(value);
    setTesting(false);
    if (!result.ok) {
      setStatus({ ok: false, message: result.error });
      return;
    }
    setValue(result.origin);
    setTestedOrigin(result.origin);
    setStatus({
      ok: true,
      message: `Connected to TubePulse Home${result.version ? ` ${result.version}` : ''}. No app data was changed.`,
    });
  };

  const useServer = async () => {
    let normalized;
    try {
      normalized = normalizePreviewOrigin(value);
    } catch (error) {
      setStatus({ ok: false, message: error.message });
      return;
    }
    if (!testedOrigin || normalized !== testedOrigin) {
      setStatus({ ok: false, message: 'Test this exact server address before using it.' });
      return;
    }

    setSaving(true);
    try {
      await saveConfiguredPreviewOrigin(normalized);
      setActiveOrigin(normalized);
      setStatus({ ok: true, message: 'Preview server saved. New requests now use this Home.' });
    } catch {
      setStatus({ ok: false, message: 'Could not save the Preview server. Try again.' });
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={COLORS.accent} />
        <Text style={styles.loadingText}>Loading Preview server…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.badge}><Text style={styles.badgeText}>PREVIEW</Text></View>
      <Text style={styles.title}>{initialSetup ? 'Connect to TubePulse Home' : 'Preview Server'}</Text>
      <Text style={styles.description}>
        {initialSetup
          ? 'Choose your self-hosted TubePulse Home before the app registers or synchronizes anything.'
          : 'Change the self-hosted Home used by this Preview app. The production TubePulse app is unaffected.'}
      </Text>

      {activeOrigin ? (
        <View style={styles.activeCard}>
          <Text style={styles.fieldLabel}>Current server</Text>
          <Text style={styles.activeValue} selectable>{activeOrigin}</Text>
        </View>
      ) : null}

      <Text style={styles.fieldLabel}>TubePulse Home URL</Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        onChangeText={onChange}
        placeholder="http://192.168.1.20:8788"
        placeholderTextColor={COLORS.textDim}
        style={styles.input}
        value={value}
      />
      <Text style={styles.hint}>
        HTTPS is required for public hostnames. Plain HTTP is accepted only for a local/private LAN address in this Preview build.
      </Text>

      <TouchableOpacity
        accessibilityRole="button"
        disabled={testing || saving}
        onPress={testConnection}
        style={[styles.button, styles.secondaryButton, (testing || saving) && styles.disabled]}
      >
        {testing ? <ActivityIndicator color={COLORS.accent} /> : <Text style={styles.secondaryButtonText}>Test connection</Text>}
      </TouchableOpacity>

      {status ? (
        <View style={[styles.status, status.ok === true ? styles.success : status.ok === false ? styles.failure : null]}>
          <Text style={styles.statusText}>{status.message}</Text>
        </View>
      ) : null}

      <TouchableOpacity
        accessibilityRole="button"
        disabled={!testedOrigin || testing || saving}
        onPress={useServer}
        style={[styles.button, styles.primaryButton, (!testedOrigin || testing || saving) && styles.disabled]}
      >
        {saving ? <ActivityIndicator color={COLORS.bg} /> : <Text style={styles.primaryButtonText}>Use this server</Text>}
      </TouchableOpacity>

      <View style={styles.note}>
        <Text style={styles.noteTitle}>Pilot limits</Text>
        <Text style={styles.noteText}>
          This side-by-side build tests registration, subscriptions and feeds with a null push token. Push notifications require a separately registered Firebase Android app for com.tubepulse.app.selfhost.
        </Text>
        <Text style={styles.noteText}>
          TubePulse Preview never falls back to the production Cloudflare API. If this Home is offline, requests fail visibly and can be retried.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content: { padding: 20, paddingTop: 28, paddingBottom: 48 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.bg },
  loadingText: { color: COLORS.textDim, marginTop: 12 },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: COLORS.accent,
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 12,
  },
  badgeText: { color: COLORS.bg, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  title: { color: COLORS.text, fontSize: 24, fontWeight: '700', marginBottom: 10 },
  description: { color: COLORS.textDim, fontSize: 14, lineHeight: 20, marginBottom: 22 },
  activeCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 18,
  },
  activeValue: { color: COLORS.text, fontSize: 13, marginTop: 4 },
  fieldLabel: { color: COLORS.textDim, fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  input: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    color: COLORS.text,
    fontSize: 15,
    marginTop: 7,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  hint: { color: COLORS.textDim, fontSize: 12, lineHeight: 17, marginTop: 7 },
  button: { borderRadius: 8, alignItems: 'center', justifyContent: 'center', minHeight: 46, marginTop: 16 },
  primaryButton: { backgroundColor: COLORS.accent },
  secondaryButton: { borderWidth: 1, borderColor: COLORS.accent, backgroundColor: COLORS.surface },
  primaryButtonText: { color: COLORS.bg, fontSize: 15, fontWeight: '700' },
  secondaryButtonText: { color: COLORS.accent, fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.4 },
  status: { borderRadius: 8, borderWidth: 1, borderColor: COLORS.border, padding: 12, marginTop: 14 },
  success: { borderColor: '#2E7D32', backgroundColor: 'rgba(46, 125, 50, 0.15)' },
  failure: { borderColor: COLORS.danger, backgroundColor: 'rgba(239, 83, 80, 0.12)' },
  statusText: { color: COLORS.text, fontSize: 13, lineHeight: 18 },
  note: { borderTopWidth: 1, borderTopColor: COLORS.border, marginTop: 28, paddingTop: 18 },
  noteTitle: { color: COLORS.text, fontSize: 14, fontWeight: '600', marginBottom: 6 },
  noteText: { color: COLORS.textDim, fontSize: 12, lineHeight: 17, marginBottom: 8 },
});
