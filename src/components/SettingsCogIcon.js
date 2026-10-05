import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { COLORS } from '../utils/constants';
import { SETTINGS_COG_PATH, SETTINGS_COG_VIEW_BOX } from '../utils/settingsCog.mjs';

export default function SettingsCogIcon({ size = 26 }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox={SETTINGS_COG_VIEW_BOX}
      accessible={false}
      focusable={false}
    >
      <Path
        d={SETTINGS_COG_PATH}
        fill={COLORS.accent}
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </Svg>
  );
}
