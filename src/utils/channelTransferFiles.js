import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import appConfig from '../../app.json';
import {
  CHANNEL_TRANSFER_MAX_BYTES,
  parseChannelTransfer,
  serializeChannelBackup,
} from './channelTransfer.mjs';

function backupFileName(now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  return `TubePulse-backup-${date}.tubepulse`;
}

export async function shareChannelBackup(input) {
  if (!FileSystem.cacheDirectory) throw new Error('Temporary file storage is unavailable.');
  if (!await Sharing.isAvailableAsync()) throw new Error('Android sharing is unavailable on this device.');
  const fileName = backupFileName();
  const uri = `${FileSystem.cacheDirectory}${fileName}`;
  const contents = serializeChannelBackup({
    ...input,
    appVersion: appConfig?.expo?.version || null,
  });
  await FileSystem.writeAsStringAsync(uri, contents, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  await Sharing.shareAsync(uri, {
    mimeType: 'application/json',
    dialogTitle: 'Export TubePulse channels',
    UTI: 'public.json',
  });
  return { fileName, uri, bytes: contents.length };
}

export async function pickChannelTransferFile() {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/json', 'text/plain', 'application/octet-stream', '*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets?.[0];
  if (!asset?.uri) throw new Error('The selected file could not be opened.');
  if (Number(asset.size) > CHANNEL_TRANSFER_MAX_BYTES) {
    throw new Error('This import file is too large. The maximum size is 512 KB.');
  }
  const text = await FileSystem.readAsStringAsync(asset.uri, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return {
    name: asset.name || 'Selected file',
    transfer: parseChannelTransfer(text, { byteLength: Number(asset.size) || undefined }),
  };
}

export { backupFileName };
