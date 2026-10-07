import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { COLORS } from '../utils/constants';
import { updatePillAnimationDecision } from '../utils/updatePillAnimation.mjs';

export default function UpdateAvailablePill({ update, visitId, onPress }) {
  const strength = useRef(new Animated.Value(0.1465)).current;
  const flashedVisit = useRef(-1);
  const [motionPreference, setMotionPreference] = useState({ ready: false, reduceMotion: true });

  useEffect(() => {
    let active = true;
    let preferenceChanged = false;
    const applyPreference = (reduceMotion, fromChange = false) => {
      if (!active) return;
      if (fromChange) preferenceChanged = true;
      setMotionPreference({ ready: true, reduceMotion: Boolean(reduceMotion) });
    };
    const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (value) => {
      applyPreference(value, true);
    });
    const initialPreference = AccessibilityInfo.isReduceMotionEnabled?.();
    if (initialPreference && typeof initialPreference.then === 'function') {
      initialPreference
        .then((value) => {
          if (!preferenceChanged) applyPreference(value);
        })
        .catch(() => {
          if (!preferenceChanged) applyPreference(true);
        });
    } else {
      applyPreference(true);
    }
    return () => {
      active = false;
      subscription?.remove?.();
    };
  }, []);

  useEffect(() => {
    const decision = updatePillAnimationDecision({
      hasUpdate: Boolean(update),
      visitId,
      handledVisitId: flashedVisit.current,
      preferenceReady: motionPreference.ready,
      reduceMotion: motionPreference.reduceMotion,
    });
    if (decision === 'none' || decision === 'wait') return;
    flashedVisit.current = visitId;
    strength.stopAnimation();
    if (decision === 'settle') {
      strength.setValue(0.1465);
      return;
    }
    strength.setValue(0);
    Animated.sequence([
      Animated.timing(strength, {
        toValue: 1,
        duration: 420,
        easing: Easing.bezier(0.33, 0, 0.2, 1),
        useNativeDriver: true,
      }),
      Animated.timing(strength, {
        toValue: 0.1465,
        duration: 630,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
        useNativeDriver: true,
      }),
    ]).start();
  }, [motionPreference, strength, update, visitId]);

  if (!update) return null;
  const haloOpacity = strength.interpolate({ inputRange: [0, 1], outputRange: [0.06, 0.64] });
  const haloScale = strength.interpolate({ inputRange: [0, 1], outputRange: [1, 1.14] });
  const version = `${update.version.major}.${update.version.minor}.${update.version.patch}`;
  return (
    <View style={styles.wrap}>
      <Animated.View style={[styles.halo, { opacity: haloOpacity, transform: [{ scale: haloScale }] }]} />
      <TouchableOpacity
        style={styles.pill}
        onPress={() => onPress(update)}
        accessibilityRole="button"
        accessibilityLabel={`Update TubePulse to version ${version}. Opens the GitHub release page.`}
        hitSlop={4}
      >
        <Text style={styles.text} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.82}>
          Update available
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'flex-end',
    minHeight: 48,
    justifyContent: 'center',
    marginTop: 4,
    marginBottom: 2,
    marginRight: 4,
  },
  halo: {
    position: 'absolute',
    left: 3,
    right: 3,
    top: 8,
    bottom: 8,
    borderRadius: 18,
    backgroundColor: COLORS.accent,
  },
  pill: {
    minHeight: 36,
    minWidth: 126,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 2,
    borderColor: COLORS.accent,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: COLORS.surface,
  },
  text: {
    color: COLORS.accent,
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
});
