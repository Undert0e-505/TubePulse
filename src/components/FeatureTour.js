import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Pressable, StyleSheet, Text, View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIsFocused } from '@react-navigation/native';
import {
  TourGuideOverlay,
  TourGuideProvider as LibraryTourGuideProvider,
  TourTarget,
  Tooltip,
  useTourGuide,
} from '@wrack/react-native-tour-guide';
import { COLORS, STORAGE_KEYS } from '../utils/constants';
import {
  FEATURE_TOUR_STAGES,
  FEATURE_TOUR_STEPS,
  featureTourExitNavigationState,
  featureTourGlobalStepNumber,
  featureTourStageSteps,
  initializeFeatureTour,
  nextFeatureTourStage,
} from '../utils/featureTourPolicy.mjs';

const FeatureTourContext = createContext(null);
const FEATURE_TOUR_TIMING = process.env.EXPO_PUBLIC_TUBEPULSE_PREVIEW === '1';

function timing(event, stepId, details = '') {
  if (!FEATURE_TOUR_TIMING) return;
  console.info(`[FeatureTourTiming] ${event} step=${stepId} at=${Date.now()}${details ? ` ${details}` : ''}`);
}

export function useFeatureTour() {
  const value = useContext(FeatureTourContext);
  if (!value) throw new Error('useFeatureTour must be used inside FeatureTourProvider');
  return value;
}

export function FeatureTourTarget({
  targetKey,
  style,
  children,
  onLayout,
}) {
  const { registerTargetReady } = useFeatureTour();
  const isFocused = useIsFocused();
  const [hasLayout, setHasLayout] = useState(false);

  const handleLayout = useCallback((event) => {
    setHasLayout(true);
    onLayout?.(event);
  }, [onLayout]);

  useEffect(() => {
    registerTargetReady(targetKey, isFocused && hasLayout);
    return () => registerTargetReady(targetKey, false);
  }, [hasLayout, isFocused, registerTargetReady, targetKey]);

  return (
    <TourTarget id={targetKey} style={style}>
      <View
        pointerEvents="none"
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        onLayout={handleLayout}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </TourTarget>
  );
}

function TourNextButton({ label, onPress, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={label === 'Done' ? 'Finish app tour' : 'Next tour step'}
      style={({ pressed }) => [styles.actionButton, styles.nextButton, (pressed || disabled) && styles.pressed]}
    >
      <Text style={styles.nextText}>{label}</Text>
    </Pressable>
  );
}

function TourSkipButton({ label, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Skip app tour"
      style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
    >
      <Text style={styles.skipText}>{label} tour</Text>
    </Pressable>
  );
}

function TourStepCounter({ currentStep, totalSteps }) {
  return <Text style={styles.progress}>Step {currentStep + 1} of {totalSteps}</Text>;
}

function FeatureTourTooltip({ stageId, currentStep, onNext, ...props }) {
  const stageSteps = featureTourStageSteps(stageId);
  const step = stageSteps[currentStep] || stageSteps[0];
  const globalStep = featureTourGlobalStepNumber(step?.id);
  const isFinal = globalStep === FEATURE_TOUR_STEPS.length;

  const next = useCallback(() => {
    timing('tap', step?.id || 'unknown');
    onNext();
  }, [onNext, step?.id]);

  return (
    <Tooltip
      {...props}
      currentStep={globalStep - 1}
      totalSteps={FEATURE_TOUR_STEPS.length}
      isLastStep={isFinal}
      onNext={next}
    />
  );
}

function FeatureTourController({ children, navigationRef, freshInstallPromise }) {
  const tour = useTourGuide();
  const [stageId, setStageId] = useState(null);
  const [targetRevision, setTargetRevision] = useState(0);
  const [scrollRevision, setScrollRevision] = useState(0);
  const readyTargets = useRef(new Set());
  const stageScroll = useRef(new Map());
  const startedStage = useRef(null);
  const lastGeometry = useRef('');

  const navigateToStage = useCallback((nextStageId) => {
    const route = FEATURE_TOUR_STAGES[nextStageId]?.route;
    const navigation = navigationRef.current;
    if (!route || !navigation) return;
    if (route === 'Home') navigation.reset?.(featureTourExitNavigationState());
    else navigation.navigate?.(route);
  }, [navigationRef]);

  const finish = useCallback((state) => {
    startedStage.current = null;
    setStageId(null);
    navigationRef.current?.reset?.(featureTourExitNavigationState());
    AsyncStorage.setItem(STORAGE_KEYS.FEATURE_TOUR_V1, state).catch(() => {});
  }, [navigationRef]);

  const completeStage = useCallback((completed, completedStageId) => {
    if (!completed) {
      finish('skipped');
      return;
    }
    const nextStageId = nextFeatureTourStage(completedStageId);
    if (!nextStageId) {
      finish('completed');
      return;
    }
    startedStage.current = null;
    setStageId(nextStageId);
    navigateToStage(nextStageId);
  }, [finish, navigateToStage]);

  const replay = useCallback(() => {
    if (tour.isActive) tour.endTour();
    startedStage.current = null;
    setStageId('homeChannels');
    navigateToStage('homeChannels');
  }, [navigateToStage, tour]);

  const registerTargetReady = useCallback((key, ready) => {
    const has = readyTargets.current.has(key);
    if (ready && !has) {
      readyTargets.current.add(key);
      setTargetRevision((value) => value + 1);
    } else if (!ready && has) {
      readyTargets.current.delete(key);
      setTargetRevision((value) => value + 1);
    }
  }, []);

  const registerStageScroll = useCallback((key, options) => {
    stageScroll.current.set(key, options);
    setScrollRevision((value) => value + 1);
    return () => {
      if (stageScroll.current.get(key) === options) {
        stageScroll.current.delete(key);
        setScrollRevision((value) => value + 1);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(freshInstallPromise).then(async (freshInstall) => {
      const state = await initializeFeatureTour({
        freshInstall,
        readState: () => AsyncStorage.getItem(STORAGE_KEYS.FEATURE_TOUR_V1),
        writeState: (value) => AsyncStorage.setItem(STORAGE_KEYS.FEATURE_TOUR_V1, value),
      });
      if (!cancelled && state === 'pending') {
        startedStage.current = null;
        setStageId('homeChannels');
        navigateToStage('homeChannels');
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [freshInstallPromise, navigateToStage]);

  useEffect(() => {
    if (!stageId || tour.isActive || startedStage.current === stageId) return undefined;
    const stage = FEATURE_TOUR_STAGES[stageId];
    const steps = featureTourStageSteps(stageId);
    if (!stage || !steps.length) return undefined;
    if (navigationRef.current?.getCurrentRoute?.()?.name !== stage.route) return undefined;
    if (!steps.every((step) => readyTargets.current.has(step.target))) return undefined;
    const scrollOptions = stage.scroll ? stageScroll.current.get(stageId) : null;
    if (stage.scroll && !scrollOptions?.scrollRef?.current) return undefined;

    let cancelled = false;
    let frame;
    let attempts = 0;
    const startWhenRegistered = () => {
      if (cancelled || startedStage.current === stageId) return;
      if (!tour.canStartTour(steps.map((step) => ({ id: step.id, targetId: step.target, title: step.title, description: step.body })))) {
        if (++attempts < 8) frame = requestAnimationFrame(startWhenRegistered);
        return;
      }
      const librarySteps = steps.map((step) => ({
        id: step.id,
        targetId: step.target,
        title: step.title,
        description: step.body,
        // The route-local stage does not start until every target has reported
        // layout readiness. Opt out of the library's generic 100 ms mount grace
        // period while still yielding once before the native measurement.
        delayBefore: 1,
        spotlightPadding: 5,
        spotlightBorderRadius: 12,
      }));
      startedStage.current = stageId;
      tour.startTour(librarySteps, {
        tourId: `tubepulse-${stageId}`,
        animationDuration: 100,
        motion: 'morph',
        autoPositionTooltip: true,
        tooltipWidth: 320,
        showProgressDots: false,
        showStepCounter: true,
        enableBackButton: false,
        enableAccessibility: true,
        waitForInteractions: false,
        statusBarStyle: 'light-content',
        spotlightStyles: {
          overlayColor: '#000000',
          overlayOpacity: 0.72,
          enablePulse: false,
        },
        tooltipStyles: {
          backgroundColor: COLORS.surface,
          borderRadius: 20,
          titleColor: COLORS.text,
          descriptionColor: COLORS.text,
          primaryButtonColor: COLORS.accent,
          skipButtonColor: COLORS.textDim,
          containerStyle: {
            borderColor: COLORS.border,
            borderWidth: 1,
            elevation: 12,
          },
        },
        components: {
          NextButton: TourNextButton,
          SkipButton: TourSkipButton,
          StepCounter: TourStepCounter,
        },
        renderTooltip: (props) => <FeatureTourTooltip {...props} stageId={stageId} />,
        scrollRef: scrollOptions?.scrollRef,
        getCurrentScrollOffset: scrollOptions?.getCurrentScrollOffset,
        onTourEnd: (completed) => completeStage(completed, stageId),
      });
    };
    frame = requestAnimationFrame(startWhenRegistered);
    return () => {
      cancelled = true;
      if (frame) cancelAnimationFrame(frame);
    };
  }, [completeStage, navigationRef, scrollRevision, stageId, targetRevision, tour]);

  useEffect(() => {
    if (!FEATURE_TOUR_TIMING || !tour.isActive || !tour.targetLayout) return;
    const step = tour.activeSteps[tour.currentStep];
    if (!step) return;
    const geometry = `${step.id}:${tour.targetLayout.x},${tour.targetLayout.y},${tour.targetLayout.width},${tour.targetLayout.height}`;
    if (lastGeometry.current === geometry) return;
    lastGeometry.current = geometry;
    timing('ready', step.id, `geometry=${JSON.stringify(tour.targetLayout)}`);
  }, [tour.activeSteps, tour.currentStep, tour.isActive, tour.targetLayout]);

  const currentStep = tour.activeSteps[tour.currentStep];
  const value = useMemo(() => ({
    active: Boolean(stageId),
    currentTarget: currentStep?.targetId || null,
    registerStageScroll,
    registerTargetReady,
    replay,
  }), [currentStep?.targetId, registerStageScroll, registerTargetReady, replay, stageId]);

  return (
    <FeatureTourContext.Provider value={value}>
      {children}
      <TourGuideOverlay />
    </FeatureTourContext.Provider>
  );
}

export function FeatureTourProvider({ children, navigationRef, freshInstallPromise }) {
  return (
    <LibraryTourGuideProvider>
      <FeatureTourController navigationRef={navigationRef} freshInstallPromise={freshInstallPromise}>
        {children}
      </FeatureTourController>
    </LibraryTourGuideProvider>
  );
}

const styles = StyleSheet.create({
  progress: { color: COLORS.textDim, fontSize: 13 },
  actionButton: {
    minHeight: 44, minWidth: 96, alignItems: 'center', justifyContent: 'center', borderRadius: 12,
  },
  nextButton: { backgroundColor: COLORS.accent, paddingHorizontal: 22 },
  pressed: { opacity: 0.65, transform: [{ scale: 0.98 }] },
  skipText: { color: COLORS.textDim, fontSize: 15, fontWeight: '600' },
  nextText: { color: COLORS.bg, fontSize: 16, fontWeight: '700' },
});
