import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Image,
  Modal,
  ScrollView,
  Switch,
} from 'react-native';
import DraggableFlatList, { ScaleDecorator } from 'react-native-draggable-flatlist';
import { useFocusEffect } from '@react-navigation/native';
import { COLORS, PREWARN_OPTIONS, VIDEOS_PER_CHANNEL_OPTIONS } from '../utils/constants';
import {
  getChannels, saveChannels,
  getChannelCache, saveChannelCache,
  getLastSeen, saveLastSeen,
  getSettings,
  getChannelNotifSettings, saveChannelNotifSettings,
  getChannelDisplaySettings, saveChannelDisplaySettings,
} from '../utils/storage';
import { resolveHandle, subscribeChannel, unsubscribeChannel, registerDevice, getDeviceId, setChannelOverride, bootstrapChannel } from '../utils/api';
import { getFCMToken } from '../utils/fcm';
import { PREVIEW_PUSH_ENABLED } from '../utils/apiEndpointConfig';
import TimeSpinner from '../components/TimeSpinner';
import { confirm } from '../components/Confirm';
import { updateWidget } from '../components/widgetTaskHandler';

// Default per-channel settings (mirrors global defaults)
const DEFAULT_CHANNEL_NOTIF = {
  notificationMode: 'relentless',
  dndEnabled: false,
  dndStart: '22:00',
  dndEnd: '07:00',
  // Tri-state for community posts: null = inherit from global, true = on, false = off.
  includeCommunityPosts: null,
  // Tri-state for prewarn: null = inherit from global prewarnMinutes,
  // number = override (one of PREWARN_OPTIONS values).
  prewarnMinutes: null,
  // Tri-state for videos shown: null = inherit from global latestVideosPerChannel,
  // number = override (1, 2, or 3).
  latestVideosPerChannel: null,
};

export default function ChannelsScreen() {
  const [channels, setChannels] = useState([]);
  const [cache, setCache] = useState({});
  const [newHandle, setNewHandle] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [perChannelEnabled, setPerChannelEnabled] = useState(false);
  const [channelNotifSettings, setChannelNotifSettings] = useState({});
  const [editingChannel, setEditingChannel] = useState(null); // handle of channel being edited
  const [editingNotif, setEditingNotif] = useState(DEFAULT_CHANNEL_NOTIF);
  const [channelDisplaySettings, setChannelDisplaySettings] = useState({});

  useFocusEffect(
    useCallback(() => {
      Promise.all([getChannels(), getChannelCache(), getSettings(), getChannelNotifSettings(), getChannelDisplaySettings()]).then(
        ([chs, ca, settings, notifSettings, displaySettings]) => {
          setChannels(chs);
          setCache(ca);
          setPerChannelEnabled(settings.perChannelNotifications || false);
          setChannelNotifSettings(notifSettings);
          setChannelDisplaySettings(displaySettings);
        }
      );
    }, [])
  );

  const openChannelNotifSettings = (handle) => {
    const existing = channelNotifSettings[handle] || DEFAULT_CHANNEL_NOTIF;
    const existingDisplay = channelDisplaySettings[handle] || {};
    setEditingNotif({
      ...DEFAULT_CHANNEL_NOTIF,
      ...existing,
      latestVideosPerChannel: existingDisplay.latestVideosPerChannel ?? null,
    });
    setEditingChannel(handle);
  };

  const saveChannelNotif = async () => {
    // Split display fields from notification fields — they're stored in separate keys.
    const { latestVideosPerChannel: _displayField, ...notifOnly } = editingNotif;

    // Save notification settings
    const updatedNotif = { ...channelNotifSettings, [editingChannel]: notifOnly };
    setChannelNotifSettings(updatedNotif);
    await saveChannelNotifSettings(updatedNotif);

    // Save display settings (only if overridden)
    const updatedDisplay = { ...channelDisplaySettings };
    if (editingNotif.latestVideosPerChannel !== null) {
      updatedDisplay[editingChannel] = { latestVideosPerChannel: editingNotif.latestVideosPerChannel };
    } else {
      delete updatedDisplay[editingChannel];
    }
    setChannelDisplaySettings(updatedDisplay);
    await saveChannelDisplaySettings(updatedDisplay);

    // Sync notification override with server. Strip null fields (the tri-state
    // "inherit" sentinel) so the override only carries fields the user
    // has actually set. Display settings are local-only (not synced to server).
    try {
      const deviceId = await getDeviceId();
      const ch = channels.find((c) => c.handle === editingChannel);
      if (ch?.channelId) {
        const overridePayload = Object.fromEntries(
          Object.entries(notifOnly).filter(([, v]) => v !== null)
        );
        await setChannelOverride(deviceId, ch.channelId, overridePayload);
      }
    } catch (e) {
      console.warn('Failed to sync channel override:', e);
    }

    setEditingChannel(null);
  };

  const resetChannelNotif = async () => {
    const updated = { ...channelNotifSettings };
    delete updated[editingChannel];
    setChannelNotifSettings(updated);
    await saveChannelNotifSettings(updated);

    // Also reset display settings for this channel
    const updatedDisplay = { ...channelDisplaySettings };
    delete updatedDisplay[editingChannel];
    setChannelDisplaySettings(updatedDisplay);
    await saveChannelDisplaySettings(updatedDisplay);

    // Delete override on server (empty override = inherit from device settings)
    try {
      const deviceId = await getDeviceId();
      const ch = channels.find((c) => c.handle === editingChannel);
      if (ch?.channelId) {
        await setChannelOverride(deviceId, ch.channelId, {});
      }
    } catch (e) {
      console.warn('Failed to reset channel override:', e);
    }

    setEditingChannel(null);
  };

  const addChannel = async () => {
    const handle = newHandle.trim().replace(/^@/, '');
    if (!handle) return;

    setAddError('');

    if (channels.some((c) => c.handle.toLowerCase() === handle.toLowerCase())) {
      setAddError(`@${handle} is already in your list.`);
      return;
    }

    setAdding(true);

    try {
      // Resolve handle via API Worker
      const deviceId = await getDeviceId();

      // Ensure device is registered before resolve (may not have completed on fresh install)
      const { getChannels, getSettings } = require('../utils/storage');
      const fcmToken = PREVIEW_PUSH_ENABLED ? await getFCMToken() : null;
      if (!PREVIEW_PUSH_ENABLED) {
        await registerDevice(deviceId, null);
      } else if (fcmToken) {
        await registerDevice(deviceId, fcmToken);
      }

      const result = await resolveHandle(deviceId, handle);

      if (!result || !result.ok) {
        const errMsg = result?.error?.includes('not registered') 
          ? 'Device not registered — try restarting the app' 
          : result?.error?.includes('not found') 
            ? `Couldn't find @${handle} — check the handle and try again.`
            : `Error: ${result?.error || 'Unknown error'}`;
        setAddError(errMsg);
        setAdding(false);
        return;
      }

      if (!result.channelId) {
        setAddError(`Couldn't find @${handle} — check the handle and try again.`);
        setAdding(false);
        return;
      }

      // Valid channel — subscribe on server FIRST, before saving locally.
      // If the server subscribe fails, we show an error and do not add the
      // channel locally. This prevents the silent failure where a channel
      // appears in the app but the server has no subscription record.
      const channelId = result.channelId;
      const name = result.name || handle;
      const avatar = result.avatar || null;

      // Subscribe to channel on server (idempotent — safe if already
      // subscribed from a previous session or self-healing init).
      let subResult;
      try {
        subResult = await subscribeChannel(deviceId, channelId);
      } catch (e) {
        subResult = { ok: false, error: e?.message || 'Network error' };
      }

      if (!subResult?.ok) {
        const reason = subResult?.error || 'Unknown error';
        setAddError(`Couldn't subscribe to @${handle}: ${reason}. Check your connection and try again.`);
        setAdding(false);
        return;
      }

      // Server subscribe succeeded — now safe to save locally.
      const serverMeta = subResult.channel?.meta;
      const finalName = serverMeta?.name || name;
      const finalAvatar = serverMeta?.avatarUrl || avatar;

      const updated = [...channels, { handle, name: finalName, channelId }];
      await saveChannels(updated);
      setChannels(updated);
      setNewHandle('');

      // Cache data — seed with whatever we have (server meta if available,
      // resolve response otherwise). Bootstrap will fill in videos.
      const existingCache = await getChannelCache();
      existingCache[handle] = {
        name: finalName,
        avatar: finalAvatar,
        videos: [],
        latestVideo: null,
        channelId,
        lastChecked: new Date().toISOString(),
      };
      await saveChannelCache(existingCache);
      setCache({ ...existingCache });

      // Seed last seen as empty
      const lastSeen = await getLastSeen();
      if (!lastSeen[handle]) {
        lastSeen[handle] = { seenIds: [] };
        await saveLastSeen(lastSeen);
      }

      // Bootstrap: fetch initial RSS data from server
      try {
        const bootResult = await bootstrapChannel(deviceId, channelId);

        if (bootResult?.ok && bootResult.videos?.length > 0) {
          // Only keep the latest video on channel add.
          // Everything is marked as seen so the user starts fresh —
          // only genuinely new uploads will appear as "New".
          const latestOnly = [bootResult.videos[0]];
          const updatedCache = await getChannelCache();
          updatedCache[handle] = {
            name: bootResult.name || finalName,
            avatar: bootResult.avatar || finalAvatar,
            videos: latestOnly,
            latestVideo: latestOnly[0] || null,
            channelId,
            lastChecked: new Date().toISOString(),
          };
          await saveChannelCache(updatedCache);
          setCache({ ...updatedCache });

          // Mark the latest video as seen locally
          const updatedLastSeen = await getLastSeen();
          if (!updatedLastSeen[handle]) updatedLastSeen[handle] = { seenIds: [] };
          const seenIds = new Set(updatedLastSeen[handle].seenIds || []);
          if (latestOnly[0]?.videoId) seenIds.add(latestOnly[0].videoId);
          updatedLastSeen[handle].seenIds = [...seenIds];
          await saveLastSeen(updatedLastSeen);

          // Mark ALL existing videos as seen on the server too,
          // so /feed won't flag old uploads as unwatched.
          try {
            const { markSeen } = require('../utils/api');
            await markSeen(deviceId, channelId, [], true);
          } catch (e) {
            console.warn('markSeen clearAll failed:', e);
          }
        }
      } catch (e) {
        console.warn('Bootstrap fetch failed:', e);
      }

      // Update widget after bootstrap completes so the cache has
      // avatar + latest video + thumbnail data ready for the widget.
      try { await updateWidget('channel-added'); } catch {}

      // Schedule a second widget update after 3 seconds to catch
      // any server-side data that arrived slightly after bootstrap
      // (e.g. the cron may have populated channel:recent in between).
      setTimeout(() => { try { updateWidget('channel-added-delayed'); } catch {} }, 3000);

    } catch (err) {
      setAddError(`Something went wrong. Check your connection and try again.`);
    }

    setAdding(false);
  };

  const removeChannel = (handle) => {
    confirm({
      title: 'Remove channel',
      message: `Remove @${handle} from your list?`,
      confirmText: 'Remove',
      destructive: true,
    }).then(async (ok) => {
      if (!ok) return;
      const removed = channels.find((c) => c.handle === handle);
      const updated = channels.filter((c) => c.handle !== handle);
      await saveChannels(updated);
      setChannels(updated);

      // Clean up cache entry for the removed channel so the widget
      // and HomeScreen don't keep showing stale data.
      try {
        const cache = await getChannelCache();
        if (cache[handle]) {
          delete cache[handle];
          await saveChannelCache(cache);
          setCache({ ...cache });
        }
        // Clean up lastSeen entry too
        const lastSeen = await getLastSeen();
        if (lastSeen[handle]) {
          delete lastSeen[handle];
          await saveLastSeen(lastSeen);
        }
      } catch (e) {
        console.warn('Failed to clean up cache for removed channel:', e);
      }

      // Unsubscribe from server
      try {
        const deviceId = await getDeviceId();
        if (removed?.channelId) {
          await unsubscribeChannel(deviceId, removed.channelId);
        }
      } catch (e) {
        console.warn('Failed to unsubscribe from server:', e);
      }

      // Update widget after channel removal
      try { await updateWidget('channel-added'); } catch {}
    });
  };

  const onDragEnd = async ({ data }) => {
    setChannels(data);
    await saveChannels(data);
    // Channel order is a local preference — no server sync needed
  };

  const renderItem = ({ item, drag, isActive }) => {
    const cached = cache[item.handle];
    const displayName = cached?.name || item.name || item.handle;
    const hasOverride = perChannelEnabled && (!!channelNotifSettings[item.handle] || !!channelDisplaySettings[item.handle]);

    return (
      <ScaleDecorator>
        <TouchableOpacity
          onLongPress={() => {
            if (perChannelEnabled) {
              openChannelNotifSettings(item.handle);
            }
            // Long press on row body = open settings (if enabled) or do nothing
          }}
          delayLongPress={200}
          style={[styles.channelRow, isActive && styles.channelRowActive]}
          activeOpacity={1}
        >
          {/* Drag handle — always triggers drag on long press */}
          <TouchableOpacity
            onLongPress={drag}
            delayLongPress={150}
            style={styles.dragHandleWrap}
            activeOpacity={1}
          >
            <Text style={styles.dragHandle}>☰</Text>
          </TouchableOpacity>

          {/* Avatar */}
          <View style={styles.avatarWrap}>
            {cached?.avatar ? (
              <Image source={{ uri: cached.avatar }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarPlaceholder]}>
                <Text style={styles.avatarLetter}>
                  {displayName.charAt(0).toUpperCase()}
                </Text>
              </View>
            )}
          </View>

          {/* Name + handle */}
          <View style={styles.channelInfo}>
            <View style={styles.channelNameRow}>
              <Text style={styles.channelName} numberOfLines={1}>{displayName}</Text>
              {hasOverride && <View style={styles.overrideDot} />}
            </View>
            <Text style={styles.channelHandle}>
              @{item.handle}{perChannelEnabled ? '  · long-press to configure' : ''}
            </Text>
          </View>

          {/* Remove */}
          <TouchableOpacity onPress={() => removeChannel(item.handle)} style={styles.removeBtn}>
            <Text style={styles.removeText}>Remove</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </ScaleDecorator>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Per-channel notification settings modal */}
      <Modal
        visible={!!editingChannel}
        animationType="slide"
        transparent
        onRequestClose={() => setEditingChannel(null)}
      >
        <View style={styles.modalOverlay}>
          <ScrollView
            style={styles.modalSheet}
            contentContainerStyle={styles.modalSheetContent}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.modalTitle}>
              Notifications — @{editingChannel}
            </Text>

            <Text style={styles.modalLabel}>Notification mode</Text>
            <View style={styles.optionGroup}>
              {['chill', 'relentless'].map((val) => (
                <TouchableOpacity
                  key={val}
                  style={[styles.option, editingNotif.notificationMode === val && styles.optionActive]}
                  onPress={() => setEditingNotif(n => ({ ...n, notificationMode: val }))}
                >
                  <Text style={[styles.optionText, editingNotif.notificationMode === val && styles.optionTextActive]}>
                    {val.charAt(0).toUpperCase() + val.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.modalLabel}>Do not disturb</Text>
            <View style={styles.dndRow}>
              <Text style={styles.dndLabel}>Enable DND</Text>
              <Switch
                value={editingNotif.dndEnabled}
                onValueChange={(v) => setEditingNotif(n => ({ ...n, dndEnabled: v }))}
                trackColor={{ false: COLORS.border, true: COLORS.accent }}
                thumbColor={editingNotif.dndEnabled ? COLORS.bg : COLORS.textDim}
              />
            </View>

            {editingNotif.dndEnabled && (
              <View style={styles.timeRow}>
                <View style={styles.timeField}>
                  <Text style={styles.timeLabel}>From</Text>
                  <TimeSpinner
                    value={editingNotif.dndStart}
                    onChange={(v) => setEditingNotif(n => ({ ...n, dndStart: v }))}
                  />
                </View>
                <Text style={styles.timeSep}>→</Text>
                <View style={styles.timeField}>
                  <Text style={styles.timeLabel}>Until</Text>
                  <TimeSpinner
                    value={editingNotif.dndEnd}
                    onChange={(v) => setEditingNotif(n => ({ ...n, dndEnd: v }))}
                  />
                </View>
              </View>
            )}

            <Text style={styles.modalLabel}>Community posts</Text>
            <View style={styles.optionGroup}>
              {[
                { value: null, label: 'Global' },
                { value: true, label: 'On' },
                { value: false, label: 'Off' },
              ].map(({ value, label }) => {
                // Tri-state compare: null matches null, true matches true, false matches false.
                const isActive = editingNotif.includeCommunityPosts === value;
                return (
                  <TouchableOpacity
                    key={label}
                    style={[styles.option, isActive && styles.optionActive]}
                    onPress={() => setEditingNotif(n => ({ ...n, includeCommunityPosts: value }))}
                  >
                    <Text style={[styles.optionText, isActive && styles.optionTextActive]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={styles.modalHint}>
              Global: use the Include community posts setting from Settings. On/Off: override for this channel only.
            </Text>

            <Text style={styles.modalLabel}>Prewarn time</Text>
            <View style={styles.dndRow}>
              <Text style={styles.dndLabel}>Override global prewarn</Text>
              <Switch
                value={editingNotif.prewarnMinutes !== null}
                onValueChange={(v) => setEditingNotif(n => ({
                  ...n,
                  prewarnMinutes: v ? (n.prewarnMinutes ?? 60) : null,
                }))}
                trackColor={{ false: COLORS.border, true: COLORS.accent }}
                thumbColor={editingNotif.prewarnMinutes !== null ? COLORS.bg : COLORS.textDim}
              />
            </View>
            {editingNotif.prewarnMinutes !== null && (
              <View style={styles.optionGroup}>
                {PREWARN_OPTIONS.map(({ label, value }) => (
                  <TouchableOpacity
                    key={value}
                    style={[styles.option, editingNotif.prewarnMinutes === value && styles.optionActive]}
                    onPress={() => setEditingNotif(n => ({ ...n, prewarnMinutes: value }))}
                  >
                    <Text style={[styles.optionText, editingNotif.prewarnMinutes === value && styles.optionTextActive]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <Text style={styles.modalHint}>
              How early to be notified before a scheduled livestream. Off: use the global setting.
            </Text>

            {/* Videos shown per channel � display setting (local-only, not synced to server) */}
            <Text style={styles.modalLabel}>Videos shown</Text>
            <View style={styles.optionGroup}>
              {[
                { value: null, label: 'Global' },
                ...VIDEOS_PER_CHANNEL_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
              ].map(({ value, label }) => {
                const isActive = editingNotif.latestVideosPerChannel === value;
                return (
                  <TouchableOpacity
                    key={String(value)}
                    style={[styles.option, isActive && styles.optionActive]}
                    onPress={() => setEditingNotif(n => ({ ...n, latestVideosPerChannel: value }))}
                  >
                    <Text style={[styles.optionText, isActive && styles.optionTextActive]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={styles.modalHint}>
              How many recent videos to show for this channel on the Home screen. Global: use the Settings default.
            </Text>

            {(channelNotifSettings[editingChannel] || channelDisplaySettings[editingChannel]) && (
              <TouchableOpacity style={styles.modalReset} onPress={resetChannelNotif}>
                <Text style={styles.modalResetText}>Reset to global defaults</Text>
              </TouchableOpacity>
            )}

            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setEditingChannel(null)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalSave} onPress={saveChannelNotif}>
                <Text style={styles.modalSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>
      {/* Add row */}
      <View style={styles.addSection}>
        <View style={styles.addRow}>
          <TextInput
            style={styles.input}
            placeholder="@handle"
            placeholderTextColor={COLORS.textDim}
            value={newHandle}
            onChangeText={(t) => { setNewHandle(t); setAddError(''); }}
            onSubmitEditing={addChannel}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={styles.addButton} onPress={addChannel} disabled={adding}>
            {adding ? (
              <ActivityIndicator color={COLORS.bg} size="small" />
            ) : (
              <Text style={styles.addButtonText}>Add</Text>
            )}
          </TouchableOpacity>
        </View>
        {addError ? <Text style={styles.errorText}>{addError}</Text> : null}
      </View>

      {channels.length === 0 && (
        <Text style={styles.emptyText}>No channels yet. Add one above.</Text>
      )}

      <DraggableFlatList
        data={channels}
        keyExtractor={(item) => item.handle}
        renderItem={renderItem}
        onDragEnd={onDragEnd}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  addSection: {
    padding: 16,
    paddingBottom: 8,
  },
  addRow: {
    flexDirection: 'row',
    gap: 10,
  },
  input: {
    flex: 1,
    backgroundColor: COLORS.surface,
    color: COLORS.text,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  addButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingHorizontal: 20,
    justifyContent: 'center',
    minWidth: 70,
    alignItems: 'center',
  },
  addButtonText: {
    color: COLORS.bg,
    fontWeight: '700',
    fontSize: 15,
  },
  errorText: {
    color: COLORS.danger,
    fontSize: 13,
    marginTop: 8,
  },

  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.bg,
  },
  channelRowActive: {
    backgroundColor: COLORS.surface,
    borderRadius: 10,
  },
  dragHandleWrap: {
    paddingRight: 12,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  dragHandle: {
    color: COLORS.textDim,
    fontSize: 18,
    opacity: 0.5,
  },
  avatarWrap: {
    marginRight: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  avatarPlaceholder: {
    backgroundColor: COLORS.surface,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarLetter: {
    color: COLORS.textDim,
    fontSize: 18,
    fontWeight: '700',
  },
  channelInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  channelName: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '600',
  },
  channelHandle: {
    color: COLORS.textDim,
    fontSize: 12,
    marginTop: 1,
  },
  removeBtn: {
    paddingHorizontal: 4,
  },
  removeText: {
    color: COLORS.danger,
    fontSize: 13,
  },

  emptyText: {
    color: COLORS.textDim,
    textAlign: 'center',
    marginTop: 40,
    fontSize: 14,
  },

  channelNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  overrideDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accent,
  },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '85%',
  },
  modalSheetContent: {
    padding: 24,
    paddingBottom: 56, // clear Android nav tray
  },
  modalTitle: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 20,
  },
  modalLabel: {
    color: COLORS.textDim,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
    marginTop: 16,
  },
  modalHint: {
    color: COLORS.textDim,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 6,
  },
  optionGroup: {
    flexDirection: 'row',
    gap: 8,
  },
  option: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  optionActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  optionText: {
    color: COLORS.textDim,
    fontSize: 14,
    fontWeight: '500',
  },
  optionTextActive: {
    color: COLORS.bg,
    fontWeight: '700',
  },
  dndRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  dndLabel: {
    color: COLORS.text,
    fontSize: 15,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginTop: 10,
  },
  timeField: {
    alignItems: 'center',
  },
  timeLabel: {
    color: COLORS.textDim,
    fontSize: 12,
    marginBottom: 6,
  },
  timeSep: {
    color: COLORS.textDim,
    fontSize: 20,
    marginTop: 20,
  },
  modalReset: {
    marginTop: 20,
    paddingVertical: 10,
    alignItems: 'center',
  },
  modalResetText: {
    color: COLORS.danger,
    fontSize: 14,
    fontWeight: '500',
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 12,
  },
  modalCancel: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  modalCancelText: {
    color: COLORS.textDim,
    fontSize: 15,
    fontWeight: '600',
  },
  modalSave: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
  },
  modalSaveText: {
    color: COLORS.bg,
    fontSize: 15,
    fontWeight: '700',
  },
});
