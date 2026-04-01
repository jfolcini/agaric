# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ── Tauri / WebView keep rules ──────────────────────────────────────
# Keep native methods called via JNI from Rust
-keep class com.blocknotes.app.** { *; }

# Keep JavaScript interface classes used by WebView
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep Tauri core classes
-keep class app.tauri.** { *; }

# Preserve native method signatures
-keepclasseswithmembernames class * {
    native <methods>;
}
