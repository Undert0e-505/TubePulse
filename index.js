import { registerRootComponent } from 'expo';
import './src/utils/notificationBackgroundTask';
import App from './App';

registerRootComponent(App);

// Register widget handler safely — native module may not be available
try {
  const { registerWidgetTaskHandler } = require('react-native-android-widget');
  const { widgetTaskHandler } = require('./src/components/widgetTaskHandler');
  registerWidgetTaskHandler(widgetTaskHandler);
} catch (e) {
  console.warn('Widget handler registration failed:', e);
}
