# Slash POS for Android

This Android app opens the hosted Slash POS in a secure native WebView. It uses the same cafe accounts and server as the web app; an internet connection is required.

The Android-only billing and order layout lives in `app/src/main/assets/android-pos.css` and `app/src/main/assets/android-pos.js`. `MainActivity` injects these files inside the Android WebView, so the hosted web POS keeps its normal layout.

The starting site is set in `app/src/main/java/com/slash/pos/MainActivity.java` (`POS_URL`). Change it there if the production POS domain changes.

## Build a debug APK on Windows

Install a Java 17+ JDK and Android SDK Platform 36 with Build Tools 36, then set `ANDROID_HOME` to the SDK folder. From the repository root, run:

```powershell
npm run android:build
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. Debug APKs are for direct installation and internal use; a signed release APK requires a release signing key.
