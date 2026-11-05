import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  getChannelCache,
  getChannelDisplaySettings,
  getChannelNotifSettings,
  getChannels,
  getLastSeen,
  getSettings,
  saveChannelCache,
  saveChannelDisplaySettings,
  saveChannelNotifSettings,
  saveChannels,
  saveLastSeen,
  saveSettings,
} from '../utils/storage';
import {
  bootstrapChannel,
  getDeviceId,
  markSeen,
  registerDevice,
  resolveHandle,
  setChannelOverride,
  subscribeChannel,
  unsubscribeChannel,
  updateSettings,
} from '../utils/api';
import { getFCMToken } from '../utils/fcm';
import { PREVIEW_PUSH_ENABLED } from '../utils/apiEndpointConfig';
import {
  applyChannelTransferOperations,
  buildImportedLocalState,
  buildImportedSilenceState,
  planChannelTransfer,
} from '../utils/channelTransfer.mjs';
import { pickChannelTransferFile, shareChannelBackup } from '../utils/channelTransferFiles';
import {
  readLocalNotificationSilence,
  writeLocalNotificationSilence,
} from '../utils/localNotificationSilenceStorage';
import { prepareChannelNotificationSettings } from '../utils/channelNotificationSettings.mjs';
import { updateWidget } from './widgetTaskHandler';
import { COLORS } from '../utils/constants';

function sameChannel(left, right) {
  if (left?.channelId && right?.channelId) return left.channelId === right.channelId;
  return String(left?.handle || '').toLowerCase() === String(right?.handle || '').toLowerCase();
}

function headlineForStage(stage, activity) {
  if (stage === 'resolving') return 'Checking channels';
  if (stage === 'preview') return 'Import channels';
  if (stage === 'confirm-replace') return 'Replace channel list?';
  if (stage === 'applying') return 'Applying import';
  if (stage === 'result') return activity === 'export' ? 'Export ready' : 'Import complete';
  if (stage === 'error') return 'Couldn’t continue';
  return 'Channel transfer';
}

export default function ChannelTransferDialog({ visible, onClose, onApplied }) {
  const [stage, setStage] = useState('menu');
  const [busyText, setBusyText] = useState('');
  const [importFile, setImportFile] = useState(null);
  const [resolvedChannels, setResolvedChannels] = useState([]);
  const [invalidChannels, setInvalidChannels] = useState([]);
  const [currentChannels, setCurrentChannels] = useState([]);
  const [message, setMessage] = useState('');
  const [activity, setActivity] = useState(null);

  useEffect(() => {
    if (!visible) return;
    setStage('menu');
    setBusyText('');
    setImportFile(null);
    setResolvedChannels([]);
    setInvalidChannels([]);
    setMessage('');
    setActivity(null);
  }, [visible]);

  const plan = useMemo(
    () => planChannelTransfer(currentChannels, resolvedChannels),
    [currentChannels, resolvedChannels],
  );

  const close = () => {
    if (stage === 'resolving' || stage === 'applying') return;
    onClose?.();
  };

  const exportChannels = async () => {
    setActivity('export');
    setStage('resolving');
    setBusyText('Preparing backup…');
    try {
      const [channels, settings, notificationSettings, displaySettings, silenceState] = await Promise.all([
        getChannels(),
        getSettings(),
        getChannelNotifSettings(),
        getChannelDisplaySettings(),
        readLocalNotificationSilence(),
      ]);
      await shareChannelBackup({
        channels,
        settings,
        notificationSettings,
        displaySettings,
        silenceState,
      });
      setMessage(`Prepared ${channels.length} channel${channels.length === 1 ? '' : 's'} for export.`);
      setStage('result');
    } catch (error) {
      setMessage(error?.message || 'The backup could not be exported.');
      setStage('error');
    }
  };

  const registerForTransfer = async () => {
    const deviceId = await getDeviceId();
    let token = null;
    if (PREVIEW_PUSH_ENABLED) {
      try { token = await getFCMToken(); } catch {}
    }
    const registration = !PREVIEW_PUSH_ENABLED
      ? await registerDevice(deviceId, null)
      : token
        ? await registerDevice(deviceId, token)
        : { ok: true };
    if (!registration?.ok) console.warn('Channel transfer registration refresh failed:', registration?.error);
    return deviceId;
  };

  const importChannels = async () => {
    try {
      setActivity('import');
      const selected = await pickChannelTransferFile();
      if (!selected) return;
      setImportFile(selected);
      setStage('resolving');
      setBusyText('Preparing channel checks…');
      const localChannels = await getChannels();
      setCurrentChannels(localChannels);
      const deviceId = await registerForTransfer();
      const resolved = [];
      const invalid = [];
      for (let index = 0; index < selected.transfer.channels.length; index += 1) {
        const imported = selected.transfer.channels[index];
        setBusyText(`Checking ${index + 1} of ${selected.transfer.channels.length}…`);
        const existing = localChannels.find((channel) => sameChannel(channel, imported));
        if (existing) {
          resolved.push({ ...imported, ...existing, handle: existing.handle });
          continue;
        }
        const resolution = await resolveHandle(deviceId, imported.handle);
        if (!resolution?.ok || !resolution.channelId) {
          invalid.push({ handle: imported.handle, error: resolution?.error || 'Channel not found' });
          continue;
        }
        resolved.push({
          ...imported,
          handle: imported.handle,
          channelId: resolution.channelId,
          name: resolution.name || imported.name || imported.handle,
          avatar: resolution.avatar || null,
        });
      }
      setResolvedChannels(resolved);
      setInvalidChannels(invalid);
      setStage('preview');
    } catch (error) {
      setMessage(error?.message || 'The selected file could not be imported.');
      setStage('error');
    }
  };

  const seedAddedChannel = async (deviceId, channel, cache, lastSeen) => {
    const entry = {
      name: channel.name || channel.handle,
      avatar: channel.avatar || null,
      videos: [],
      latestVideo: null,
      channelId: channel.channelId,
      lastChecked: new Date().toISOString(),
    };
    cache[channel.handle] = entry;
    if (!lastSeen[channel.handle]) lastSeen[channel.handle] = { seenIds: [] };
    try {
      const boot = await bootstrapChannel(deviceId, channel.channelId);
      if (boot?.ok && boot.videos?.length) {
        const latest = boot.videos[0];
        cache[channel.handle] = {
          ...entry,
          name: boot.name || entry.name,
          avatar: boot.avatar || entry.avatar,
          videos: [latest],
          latestVideo: latest,
        };
        if (latest?.videoId) {
          lastSeen[channel.handle].seenIds = [...new Set([
            ...(lastSeen[channel.handle].seenIds || []),
            latest.videoId,
          ])];
        }
      }
      await markSeen(deviceId, channel.channelId, [], true);
    } catch (error) {
      console.warn(`Imported channel bootstrap failed for ${channel.handle}:`, error);
    }
  };

  const applyImport = async (mode) => {
    if (!importFile || invalidChannels.length) return;
    setStage('applying');
    setBusyText('Updating subscriptions…');
    try {
      const deviceId = await registerForTransfer();
      const operation = await applyChannelTransferOperations({
        mode,
        currentChannels,
        importedChannels: resolvedChannels,
        subscribe: async (channel) => await subscribeChannel(deviceId, channel.channelId),
        unsubscribe: async (channel) => await unsubscribeChannel(deviceId, channel.channelId),
      });
      const [currentNotif, currentDisplay, currentSettings, currentSilence, cache, lastSeen] = await Promise.all([
        getChannelNotifSettings(),
        getChannelDisplaySettings(),
        getSettings(),
        readLocalNotificationSilence(),
        getChannelCache(),
        getLastSeen(),
      ]);

      const effectiveMode = operation.addFailures.length ? 'merge' : mode;
      const importedForLocal = resolvedChannels
        .filter((imported) => operation.finalChannels.some((channel) => sameChannel(channel, imported)))
        .map((imported) => {
          const actual = operation.finalChannels.find((channel) => sameChannel(channel, imported));
          return { ...imported, ...actual, handle: actual.handle };
        });
      const local = buildImportedLocalState({
        mode: effectiveMode,
        currentChannels,
        resolvedChannels: importedForLocal,
        currentNotificationSettings: currentNotif,
        currentDisplaySettings: currentDisplay,
        currentSettings,
        importedSettings: importFile.transfer.settings,
      });
      local.channels = operation.finalChannels;

      if (mode === 'replace' && !operation.addFailures.length) {
        for (const retained of operation.retainedRemovals) {
          if (currentNotif[retained.handle]) local.notificationSettings[retained.handle] = currentNotif[retained.handle];
          if (currentDisplay[retained.handle]) local.displaySettings[retained.handle] = currentDisplay[retained.handle];
        }
      }

      setBusyText('Restoring local preferences…');
      const removedHandles = new Set(operation.removed.map((channel) => channel.handle));
      for (const handle of removedHandles) {
        delete cache[handle];
        delete lastSeen[handle];
      }
      for (const channel of operation.added) {
        await seedAddedChannel(deviceId, channel, cache, lastSeen);
      }

      const silenceMode = mode === 'replace' && importFile.transfer.kind === 'handles'
        ? 'merge'
        : effectiveMode;
      const nextSilence = buildImportedSilenceState({
        mode: silenceMode,
        currentState: currentSilence,
        importedChannels: importedForLocal,
        importedAllMuted: importFile.transfer.notificationSilence?.allMuted,
        newChannelHandles: operation.added.map((channel) => channel.handle),
      });
      await Promise.all([
        saveChannels(local.channels),
        saveChannelNotifSettings(local.notificationSettings),
        saveChannelDisplaySettings(local.displaySettings),
        saveSettings(local.settings),
        saveChannelCache(cache),
        saveLastSeen(lastSeen),
        writeLocalNotificationSilence(nextSilence),
      ]);

      const warnings = [];
      if (mode === 'replace' && !operation.addFailures.length && importFile.transfer.kind === 'backup') {
        const settingsResult = await updateSettings(deviceId, local.settings);
        if (!settingsResult?.ok) warnings.push('Global notification settings will retry on the next app launch.');
      }
      const overrideTargets = effectiveMode === 'replace' ? importedForLocal : operation.added;
      for (const channel of overrideTargets) {
        const imported = importedForLocal.find((entry) => sameChannel(entry, channel));
        if (!imported?.channelId) continue;
        const { overridePayload } = prepareChannelNotificationSettings(imported.notification || {});
        const result = await setChannelOverride(deviceId, imported.channelId, overridePayload);
        if (!result?.ok) warnings.push(`Settings for @${imported.handle} will retry when edited.`);
      }

      try { await updateWidget('channel-import'); } catch {}
      await onApplied?.();
      const parts = [
        `${operation.added.length} added`,
        `${operation.removed.length} removed`,
      ];
      if (operation.addFailures.length) parts.push(`${operation.addFailures.length} could not be added`);
      if (operation.removeFailures.length) parts.push(`${operation.removeFailures.length} could not be removed`);
      setMessage(`${parts.join(' · ')}.${warnings.length ? ` ${[...new Set(warnings)].join(' ')}` : ''}`);
      setStage('result');
    } catch (error) {
      setMessage(error?.message || 'The import could not be completed.');
      setStage('error');
      await onApplied?.();
    }
  };

  const previewBlocked = invalidChannels.length > 0 || !resolvedChannels.length;
  const title = headlineForStage(stage, activity);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={close}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={close} accessibilityRole="button">
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>

          {stage === 'menu' ? (
            <View>
              <TouchableOpacity
                style={styles.actionRow}
                onPress={importChannels}
                accessibilityRole="button"
                accessibilityLabel="Import channels"
              >
                <View style={styles.actionCopy}>
                  <Text style={styles.actionTitle}>Import channels</Text>
                  <Text style={styles.actionHint}>Backup or @handles text list; # lines are comments</Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.actionRow}
                onPress={exportChannels}
                accessibilityRole="button"
                accessibilityLabel="Export channels"
              >
                <View style={styles.actionCopy}>
                  <Text style={styles.actionTitle}>Export channels</Text>
                  <Text style={styles.actionHint}>Share a local backup of channels and settings</Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.closeButton} onPress={close}>
                <Text style={styles.closeText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {(stage === 'resolving' || stage === 'applying') ? (
            <View style={styles.busy} accessibilityLiveRegion="polite">
              <ActivityIndicator color={COLORS.accent} />
              <Text style={styles.busyText}>{busyText}</Text>
            </View>
          ) : null}

          {stage === 'preview' ? (
            <ScrollView style={styles.previewScroll} contentContainerStyle={styles.previewContent}>
              <Text style={styles.fileName} numberOfLines={2}>{importFile?.name}</Text>
              <View style={styles.statRow}><Text style={styles.statLabel}>Channels found</Text><Text style={styles.statValue}>{resolvedChannels.length + invalidChannels.length}</Text></View>
              <View style={styles.statRow}><Text style={styles.statLabel}>New channels</Text><Text style={styles.statValue}>{plan.additions.length}</Text></View>
              <View style={styles.statRow}><Text style={styles.statLabel}>Already followed</Text><Text style={styles.statValue}>{plan.existing.length}</Text></View>
              <View style={styles.statRow}><Text style={styles.statLabel}>Replace would remove</Text><Text style={styles.statValue}>{plan.removals.length}</Text></View>
              <View style={styles.statRow}><Text style={styles.statLabel}>Transferable settings</Text><Text style={styles.statValue}>{importFile?.transfer?.hasSettings ? 'Yes' : 'No'}</Text></View>
              {invalidChannels.length ? (
                <Text style={styles.errorText} accessibilityLiveRegion="polite">
                  {invalidChannels.length} channel{invalidChannels.length === 1 ? '' : 's'} could not be validated. Fix the file and try again. First: @{invalidChannels[0].handle}
                </Text>
              ) : null}
              <Text style={styles.explainer}>
                Merge keeps your current list and settings. Replace uses this file as the channel list.
              </Text>
              <View style={[styles.buttonRow, styles.previewButtonRow]}>
                <TouchableOpacity style={[styles.cancelButton, styles.previewButton]} onPress={close}>
                  <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.secondaryButton, styles.previewButton, previewBlocked && styles.disabledButton]}
                  disabled={previewBlocked}
                  onPress={() => setStage('confirm-replace')}
                >
                  <Text style={styles.secondaryText}>Replace</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.primaryButton, styles.previewButton, previewBlocked && styles.disabledButton]}
                  disabled={previewBlocked}
                  onPress={() => applyImport('merge')}
                >
                  <Text style={styles.primaryText}>Merge</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          ) : null}

          {stage === 'confirm-replace' ? (
            <View>
              <Text style={styles.message}>
                This will remove {plan.removals.length} channel{plan.removals.length === 1 ? '' : 's'} and make the imported order authoritative. New channels are validated and added before anything is removed.
              </Text>
              <View style={styles.buttonRow}>
                <TouchableOpacity style={styles.cancelButton} onPress={() => setStage('preview')}>
                  <Text style={styles.cancelText}>Back</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.destructiveButton} onPress={() => applyImport('replace')}>
                  <Text style={styles.primaryText}>Replace</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          {(stage === 'result' || stage === 'error') ? (
            <View>
              <Text style={[styles.message, stage === 'error' && styles.errorText]}>{message}</Text>
              <View style={styles.buttonRow}>
                {stage === 'error' ? (
                  <TouchableOpacity style={styles.cancelButton} onPress={() => setStage('menu')}>
                    <Text style={styles.cancelText}>Back</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity style={styles.primaryButton} onPress={close}>
                  <Text style={styles.primaryText}>Done</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '82%',
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
  },
  title: { color: COLORS.text, fontSize: 20, fontWeight: '700', marginBottom: 14 },
  actionRow: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopColor: COLORS.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionCopy: { flex: 1, paddingVertical: 12, paddingRight: 12 },
  actionTitle: { color: COLORS.text, fontSize: 16, fontWeight: '600' },
  actionHint: { color: COLORS.textDim, fontSize: 12, lineHeight: 17, marginTop: 3 },
  chevron: { color: COLORS.accent, fontSize: 28 },
  closeButton: { alignSelf: 'flex-end', minHeight: 48, justifyContent: 'center', paddingHorizontal: 12, marginTop: 8 },
  closeText: { color: COLORS.textDim, fontSize: 14, fontWeight: '600' },
  busy: { minHeight: 120, alignItems: 'center', justifyContent: 'center' },
  busyText: { color: COLORS.textDim, marginTop: 14, fontSize: 14 },
  previewScroll: { flexShrink: 1 },
  previewContent: { paddingBottom: 2 },
  fileName: { color: COLORS.textDim, fontSize: 12, marginBottom: 12 },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', minHeight: 30, alignItems: 'center' },
  statLabel: { color: COLORS.textDim, fontSize: 14 },
  statValue: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  explainer: { color: COLORS.textDim, fontSize: 13, lineHeight: 18, marginTop: 14 },
  errorText: { color: COLORS.danger, fontSize: 13, lineHeight: 18, marginTop: 12 },
  message: { color: COLORS.textDim, fontSize: 14, lineHeight: 21, marginBottom: 18 },
  buttonRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginTop: 18, gap: 8, flexWrap: 'wrap' },
  previewButtonRow: { flexWrap: 'nowrap' },
  previewButton: { flex: 1, minWidth: 0, paddingHorizontal: 8 },
  cancelButton: { minHeight: 46, justifyContent: 'center', paddingHorizontal: 12 },
  cancelText: { color: COLORS.textDim, fontSize: 14, fontWeight: '600' },
  primaryButton: { minHeight: 46, minWidth: 88, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: COLORS.accent, paddingHorizontal: 18 },
  primaryText: { color: COLORS.bg, fontSize: 14, fontWeight: '700' },
  secondaryButton: { minHeight: 46, minWidth: 88, alignItems: 'center', justifyContent: 'center', borderRadius: 8, borderColor: COLORS.border, borderWidth: 1, paddingHorizontal: 18 },
  secondaryText: { color: COLORS.text, fontSize: 14, fontWeight: '600' },
  destructiveButton: { minHeight: 46, minWidth: 96, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: COLORS.danger, paddingHorizontal: 18 },
  disabledButton: { opacity: 0.35 },
});
