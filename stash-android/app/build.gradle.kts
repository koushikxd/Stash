import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The single shared secret both apps bake in so the Mac knows the link came from
// "me". Read from a gitignored secrets.properties (or the STASH_SHARED_SECRET env
// var) so the real value never lands in git; falls back to a placeholder that lets
// the project build but can never authenticate until configured. The SAME value
// must be set on the Mac (stash-mac/stash.secret.json or the STASH_SHARED_SECRET
// env var).
fun secretsProperty(name: String): String? {
    val fromEnv = System.getenv(name)
    if (!fromEnv.isNullOrBlank()) return fromEnv
    val propsFile = rootProject.file("secrets.properties")
    if (propsFile.exists()) {
        val props = Properties()
        propsFile.inputStream().use { stream -> props.load(stream) }
        val fromProps = props.getProperty(name)
        if (!fromProps.isNullOrBlank()) return fromProps
    }
    return null
}

/** Quote a value for a generated `String` BuildConfig field. */
fun stringLiteral(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("$", "\\$") + "\""

val stashSharedSecret: String =
    secretsProperty("STASH_SHARED_SECRET") ?: "stash-android-unconfigured-shared-secret"

// Upstash Redis REST credentials for the relay transport. Absent values build fine;
// the app simply can't reach the relay until they're configured.
val upstashRestUrl: String = secretsProperty("UPSTASH_REDIS_REST_URL").orEmpty().trimEnd('/')
val upstashRestToken: String = secretsProperty("UPSTASH_REDIS_REST_TOKEN").orEmpty()

android {
    namespace = "dev.koushik.stash"
    compileSdk = 34
    val releaseStoreFile = System.getenv("STASH_ANDROID_KEYSTORE")

    defaultConfig {
        applicationId = "dev.koushik.stash"
        minSdk = 29
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "STASH_SECRET", stringLiteral(stashSharedSecret))
        buildConfigField("String", "UPSTASH_REDIS_REST_URL", stringLiteral(upstashRestUrl))
        buildConfigField("String", "UPSTASH_REDIS_REST_TOKEN", stringLiteral(upstashRestToken))
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        create("release") {
            if (!releaseStoreFile.isNullOrBlank()) {
                storeFile = file(releaseStoreFile)
                storePassword = System.getenv("STASH_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("STASH_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("STASH_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (!releaseStoreFile.isNullOrBlank()) signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
}
