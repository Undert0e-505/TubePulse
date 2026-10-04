import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Platform, Switch, ScrollView,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { COLORS, DEFAULT_SETTINGS, NAG_INTERVALS, PREWARN_OPTIONS, VIDEOS_PER_CHANNEL_OPTIONS } from '../utils/constants';
import TimeSpinner from '../components/TimeSpinner';
import { getSettings, saveSettings } from '../utils/storage';
import { updateSettings, getDeviceId } from '../utils/api';
import { IS_TUBEPULSE_PREVIEW } from '../utils/apiEndpointConfig';

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function SettingsScreen() {
  const navigation = useNavigation();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  useFocusEffect(
    useCallback(() => {
      getSettings().then(setSettings);
    }, [])
  );

  const updateSetting = async (key, value) => {
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    await saveSettings(updated);

    // Sync settings with API Worker
    try {
      const deviceId = await getDeviceId();
      await updateSettings(deviceId, updated);
    } catch (e) {
      console.warn('Failed to sync settings with server:', e);
    }
  };

  const mode = settings.notificationMode || 'relentless';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* Tap Action */}
      <Text style={[styles.sectionTitle, styles.sectionTitleFirst]}>On tap, open:</Text>
      <View style={styles.optionGroup}>
        {['video', 'channel'].map((val) => (
          <TouchableOpacity
            key={val}
            style={[styles.option, settings.tapAction === val && styles.optionActive]}
            onPress={() => updateSetting('tapAction', val)}
          >
            <Text style={[styles.optionText, settings.tapAction === val && styles.optionTextActive]}>
              {val === 'video' ? 'Video' : 'Channel page'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.guidance}>
        {settings.tapAction === 'video'
          ? 'Opens the specific video in YouTube and marks it as watched.'
          : 'Opens the channel page in YouTube and marks all their videos as watched.'}
      </Text>

      {/* Notification Mode */}
      <Text style={styles.sectionTitle}>Notification mode</Text>
      <View style={styles.optionGroup}>
        {['chill', 'relentless'].map((val) => (
          <TouchableOpacity
            key={val}
            style={[styles.option, mode === val && styles.optionActive]}
            onPress={() => updateSetting('notificationMode', val)}
          >
            <Text style={[styles.optionText, mode === val && styles.optionTextActive]}>
              {val.charAt(0).toUpperCase() + val.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.guidance}>
        {mode === 'chill'
          ? 'Chill: notify once, then remind roughly every 4 hours until you watch it.'
          : "Relentless: remind you every nag interval until you've watched it."}
      </Text>

      {/* Nag Interval */}
      <Text style={[styles.sectionTitle, mode === 'chill' && styles.sectionTitleDisabled]}>Nag interval</Text>
      <View style={styles.optionGroup} pointerEvents={mode === 'chill' ? 'none' : 'auto'}>
        {NAG_INTERVALS.map(({ label, value }) => (
          <TouchableOpacity
            key={value}
            style={[
              styles.option,
              settings.nagInterval === value && styles.optionActive,
              mode === 'chill' && styles.optionDisabled,
            ]}
            onPress={() => updateSetting('nagInterval', value)}
            disabled={mode === 'chill'}
          >
            <Text style={[
              styles.optionText,
              settings.nagInterval === value && styles.optionTextActive,
              mode === 'chill' && styles.optionTextDisabled,
            ]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.guidance}>
        {mode === 'chill'
          ? 'Chill mode reminds roughly every 4 hours. Nag interval only applies to Relentless mode.'
          : settings.nagInterval === 5
            ? '5-minute reminders run for the first hour, then back off to 15 minutes.'
            : 'Relentless mode repeats reminders using the selected interval while items remain unread.'}
      </Text>

      {/* Do Not Disturb */}
      <Text style={styles.sectionTitle}>Do not disturb</Text>
      <View style={styles.dndRow}>
        <Text style={styles.dndLabel}>Enable DND</Text>
        <Switch
          value={settings.dndEnabled || false}
          onValueChange={(v) => updateSetting('dndEnabled', v)}
          trackColor={{ false: COLORS.border, true: COLORS.accent }}
          thumbColor={settings.dndEnabled ? COLORS.bg : COLORS.textDim}
        />
      </View>

      {settings.dndEnabled && (
        <>
          <Text style={styles.guidance}>
            During DND, all notifications are held. They'll come through when DND ends.
          </Text>
          <View style={styles.timeRow}>
            <View style={styles.timeField}>
              <Text style={styles.timeLabel}>From</Text>
              <TimeSpinner
                value={settings.dndStart || '22:00'}
                onChange={(v) => updateSetting('dndStart', v)}
              />
            </View>
            <Text style={styles.timeSep}>→</Text>
            <View style={styles.timeField}>
              <Text style={styles.timeLabel}>Until</Text>
              <TimeSpinner
                value={settings.dndEnd || '07:00'}
                onChange={(v) => updateSetting('dndEnd', v)}
              />
            </View>
          </View>
        </>
      )}

      {/* Prewarn time for scheduled livestreams */}
      <Text style={styles.sectionTitle}>Live stream prewarn time</Text>
      <View style={styles.optionGroupNarrow}>
        {PREWARN_OPTIONS.map(({ label, value }) => (
          <TouchableOpacity
            key={value}
            style={[styles.optionNarrow, settings.prewarnMinutes === value && styles.optionActive]}
            onPress={() => updateSetting('prewarnMinutes', value)}
          >
            <Text style={[styles.optionText, settings.prewarnMinutes === value && styles.optionTextActive]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.guidance}>
        How early to be notified before a scheduled livestream goes live.
      </Text>

      {/* Community Posts toggle */}
      <Text style={styles.sectionTitle}>Content types</Text>
      <View style={styles.dndRow}>
        <View style={styles.switchLabelWrap}>
          <Text style={styles.dndLabel}>Include community posts</Text>
          <Text style={styles.switchSubtitle}>Show channel community posts in your feed</Text>
        </View>
        <Switch
          value={settings.includeCommunityPosts || false}
          onValueChange={(v) => updateSetting('includeCommunityPosts', v)}
          trackColor={{ false: COLORS.border, true: COLORS.accent }}
          thumbColor={settings.includeCommunityPosts ? COLORS.bg : COLORS.textDim}
        />
      </View>

      {/* HomeScreen display settings */}
      <Text style={styles.sectionTitle}>Home screen</Text>
      <Text style={styles.dndLabel} numberOfLines={1}>Videos shown per channel</Text>
      <View style={styles.optionGroupNarrow}>
        {VIDEOS_PER_CHANNEL_OPTIONS.map(({ label, value }) => (
          <TouchableOpacity
            key={value}
            style={[styles.optionNarrow, settings.latestVideosPerChannel === value && styles.optionActive]}
            onPress={() => updateSetting('latestVideosPerChannel', value)}
          >
            <Text style={[styles.optionText, settings.latestVideosPerChannel === value && styles.optionTextActive]}>
              {label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.guidance}>
        Controls how many recent videos appear for each channel on the Home screen.
      </Text>

      {/* Per-channel notification settings */}
      <Text style={styles.sectionTitle}>Per-channel notifications</Text>
      <View style={styles.dndRow}>
        <View style={styles.switchLabelWrap}>
          <Text style={styles.dndLabel}>Per-channel settings</Text>
          <Text style={styles.switchSubtitle}>Override notification mode and DND per channel</Text>
        </View>
        <Switch
          value={settings.perChannelNotifications || false}
          onValueChange={(v) => updateSetting('perChannelNotifications', v)}
          trackColor={{ false: COLORS.border, true: COLORS.accent }}
          thumbColor={settings.perChannelNotifications ? COLORS.bg : COLORS.textDim}
        />
      </View>
      {settings.perChannelNotifications && (
        <Text style={styles.guidance}>
          Long-press a channel to configure its own notification settings.
        </Text>
      )}

      {/* Push Architecture Note */}
      <Text style={styles.sectionTitle}>Push notifications</Text>
      <Text style={styles.guidance}>
        {IS_TUBEPULSE_PREVIEW
          ? 'Push is disabled in this pilot APK. API, feed and subscription testing uses a null push token.'
          : 'TubePulse uses WebSub — YouTube pushes to us the instant a video drops, then we push to you. Your phone never polls. No battery drain.'}
      </Text>

      {IS_TUBEPULSE_PREVIEW ? (
        <>
          <Text style={styles.sectionTitle}>Preview</Text>
          <TouchableOpacity style={styles.serverButton} onPress={() => navigation.navigate('PreviewServer')}>
            <View style={styles.switchLabelWrap}>
              <Text style={styles.dndLabel}>Preview Server</Text>
              <Text style={styles.switchSubtitle}>View, test or change this app's TubePulse Home</Text>
            </View>
            <Text style={styles.serverChevron}>›</Text>
          </TouchableOpacity>
        </>
      ) : null}

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 0,
    paddingBottom: 40,
  },
  sectionTitle: {
    color: COLORS.textDim,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 6,
  },
  sectionTitleFirst: {
    marginTop: 4,
  },
  sectionTitleDisabled: {
    opacity: 0.4,
  },
  optionDisabled: {
    opacity: 0.35,
  },
  optionTextDisabled: {
    opacity: 0.5,
  },
  optionGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  optionGroupNarrow: {
    flexDirection: 'row',
    gap: 4,
  },
  option: {
    flex: 1,
    minWidth: 60,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionNarrow: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionActive: {
    backgroundColor: COLORS.accent,
    borderColor: COLORS.accent,
  },
  optionText: {
    color: COLORS.textDim,
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
  },
  optionTextActive: {
    color: COLORS.bg,
    fontWeight: '700',
  },
  guidance: {
    color: COLORS.textDim,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 4,
    marginBottom: 2,
  },
  dndRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 5,
  },
  dndLabel: {
    color: COLORS.text,
    fontSize: 15,
  },
  switchLabelWrap: {
    flex: 1,
    paddingRight: 12,
  },
  switchSubtitle: {
    color: COLORS.textDim,
    fontSize: 12,
    marginTop: 2,
  },
  serverButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  serverChevron: {
    color: COLORS.accent,
    fontSize: 24,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginTop: 6,
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
});
