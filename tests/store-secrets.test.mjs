import {test} from 'node:test';import assert from 'node:assert/strict';
import {missingStoreSecrets} from '../scripts/check-store-secrets.mjs';
test('preview assets do not require either store connection',()=>assert.deepEqual(missingStoreSecrets('both','previews',{}),[]));
test('iOS builds require only Apple secrets',()=>assert.deepEqual(missingStoreSecrets('ios','testers',{}),['ASC_KEY_ID','ASC_ISSUER_ID','ASC_KEY_P8','MATCH_PASSWORD','SHIPYARD_TOKEN']));
test('Android build-only does not require Play upload credentials',()=>assert.deepEqual(missingStoreSecrets('android','build-only',{}),['ANDROID_KEYSTORE_BASE64','ANDROID_KEYSTORE_PASSWORD']));
test('check tests presence without reporting credential values',()=>assert.deepEqual(missingStoreSecrets('android','testers',{ANDROID_KEYSTORE_BASE64:'private-value',ANDROID_KEYSTORE_PASSWORD:'private-value',PLAY_JSON_KEY:'private-value'}),[]));
