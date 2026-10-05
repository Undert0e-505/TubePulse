import React, { useRef, useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  runOnJS,
  withSpring,
} from 'react-native-reanimated';
import { COLORS } from '../utils/constants';
import { stepTime } from '../utils/timeSpinner.mjs';

const STEP_HEIGHT = 40; // px per unit of change

function SpinnerColumn({ value, onCommit, label, compact, onInteractionChange }) {
  const offset = useSharedValue(0);

  // Use a ref so the gesture always has the latest commit function
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const doCommit = useCallback((delta) => {
    commitRef.current(delta);
  }, []);

  const interactionRef = useRef(onInteractionChange);
  interactionRef.current = onInteractionChange;

  const setInteracting = useCallback((active) => {
    interactionRef.current?.(active);
  }, []);

  const gesture = Gesture.Pan()
    .onBegin(() => {
      runOnJS(setInteracting)(true);
    })
    .onUpdate((e) => {
      offset.value = e.translationY * 0.25;
    })
    .onEnd((e) => {
      const steps = -Math.round(e.translationY / STEP_HEIGHT);
      offset.value = withSpring(0, { damping: 20, stiffness: 400 });
      if (steps !== 0) runOnJS(doCommit)(steps);
    })
    .onFinalize(() => {
      runOnJS(setInteracting)(false);
    })
    .activeOffsetY([-4, 4])
    .failOffsetX([-24, 24])
    .minDistance(5);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View style={[styles.column, compact && styles.columnCompact]}>
        <Animated.Text maxFontSizeMultiplier={1.2} style={[styles.digit, compact && styles.digitCompact, animStyle]}>
          {String(value).padStart(2, '0')}
        </Animated.Text>
        <Text maxFontSizeMultiplier={1.3} style={styles.hint}>{label}</Text>
      </View>
    </GestureDetector>
  );
}

export default function TimeSpinner({ value, onChange, compact = false, onInteractionChange }) {
  const [h, m] = value.split(':').map(Number);

  const commitHour = useCallback((delta) => {
    onChange(stepTime(value, 'hour', delta));
  }, [value, onChange]);

  const commitMinute = useCallback((delta) => {
    onChange(stepTime(value, 'minute', delta));
  }, [value, onChange]);

  return (
    <View style={[styles.container, compact && styles.containerCompact]}>
      <SpinnerColumn
        value={h}
        onCommit={commitHour}
        label="hr"
        compact={compact}
        onInteractionChange={onInteractionChange}
      />
      <Text maxFontSizeMultiplier={1.2} style={[styles.colon, compact && styles.colonCompact]}>:</Text>
      <SpinnerColumn
        value={m}
        onCommit={commitMinute}
        label="min"
        compact={compact}
        onInteractionChange={onInteractionChange}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 4,
  },
  containerCompact: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    gap: 2,
  },
  column: {
    alignItems: 'center',
    width: 52,
    height: 60,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  columnCompact: {
    width: 44,
    height: 52,
  },
  digit: {
    color: COLORS.text,
    fontSize: 32,
    fontWeight: '700',
    lineHeight: 40,
  },
  digitCompact: {
    fontSize: 28,
    lineHeight: 34,
  },
  colon: {
    color: COLORS.text,
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 14,
  },
  colonCompact: {
    fontSize: 27,
    marginBottom: 12,
  },
  hint: {
    color: COLORS.textDim,
    fontSize: 10,
    opacity: 0.6,
  },
});
