import CryptoKit
import Foundation

/// Key and stream name derived from the shared secret. Must match
/// `stash-android/.../util/Crypto.kt` byte for byte.
struct RelayCrypto {
  private static let ivBytes = 12
  private static let tagBytes = 16

  private let key: SymmetricKey
  /// `st-` plus the first 32 lowercase hex chars of SHA256("topic:main:" + secret).
  let stream: String

  init(secret: String) {
    key = SymmetricKey(data: SHA256.hash(data: Data("key:\(secret)".utf8)))
    let digest = SHA256.hash(data: Data("topic:main:\(secret)".utf8))
    stream = "st-" + digest.map { String(format: "%02x", $0) }.joined().prefix(32)
  }

  /// `body` is base64(iv[12] || ciphertext || tag[16]). Any failure returns nil.
  func decrypt(_ body: String) -> String? {
    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let raw = Data(base64Encoded: trimmed), raw.count > Self.ivBytes + Self.tagBytes else { return nil }
    do {
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: raw.prefix(Self.ivBytes)),
        ciphertext: raw.dropFirst(Self.ivBytes).dropLast(Self.tagBytes),
        tag: raw.suffix(Self.tagBytes)
      )
      return String(decoding: try AES.GCM.open(box, using: key), as: UTF8.self)
    } catch {
      return nil
    }
  }
}
