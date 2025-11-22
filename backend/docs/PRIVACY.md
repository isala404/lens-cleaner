# Privacy Policy

**Last Updated:** November 2025

**Tallisa** ("we," "us," or "our") operates the TopPics Chrome Extension. We believe your photos are your most personal data, and our architecture is built to ensure they stay that way.

This Privacy Policy explains how we collect, use, and protect your information, specifically highlighting our local-first architecture.

## 1. The 100% Local-First Architecture (Free / Standard Features)

Unlike most photo management tools, **TopPics is designed to run entirely in your web browser** for all core functionality.

*   **Local Execution**: We utilize **WebAssembly (WASM)** technology to run the **CLIP (Contrastive Language-Image Pre-training)** neural network model directly on your device's CPU/GPU.
*   **No Image Uploads**: During standard scanning, grouping, and reviewing, your photos, thumbnails, and image data **never leave your computer**.
*   **Local Vector Embeddings**: The mathematical representations (embeddings) of your photos used for similarity matching are generated locally and stored in your browser's `IndexedDB`.
*   **Data Persistence**: All metadata about your photo groups is stored strictly within your browser. If you uninstall the extension or clear your browser data, this information is permanently removed.

## 2. Premium Features ("Auto-Select")

If—and only if—you choose to pay for and use the specific "Auto-Select" feature, the following limited cloud processing occurs:

*   **Explicit Action Required**: Data only leaves your device when you explicitly select photos and click "Start Processing" for a paid job.
*   **Temporary Processing Pipeline**: The specific photos you selected are securely transmitted to our processing pipeline.
*   **External AI**: We use Google Gemini AI (via Google Cloud) to analyze these photos for subjective quality metrics (sharpness, expressions, composition).
*   **Ephemeral Existence & Permanent Deletion**:
    *   Photos are processed in ephemeral memory or temporary storage strictly for the duration of the analysis.
    *   **Immediate Deletion**: Immediately upon completion of the analysis and return of the results to your browser, your photos are **permanently deleted** from our servers and the AI processing pipeline.
    *   **No Training**: We do not retain, archive, or use your photos to train our models or the models of our third-party providers.

## 3. Information We Collect

### 3.1. Personal Information
We do not require you to create an account to use the free features of TopPics.

### 3.2. Payment Information
Payments are processed by **Polar.sh**, our merchant of record.
*   Tallisa **does not** see, collect, or store your credit card number, bank details, or billing address.
*   We receive only a transaction confirmation (Success/Failure) and a unique Customer ID to verify your purchase and handle support requests.

### 3.3. Telemetry & Usage Data
We may collect anonymous, aggregate telemetry (e.g., "Extension opened," "Scan completed," "Error occurred") to help us fix bugs and improve performance. This data contains **no personal identifiers** and **no photo content**.

## 4. Data Sharing

We do not sell, trade, or rent your personal data. We only share data with trusted infrastructure providers strictly necessary to deliver the service:

*   **Google Cloud**: For ephemeral AI processing (only for Premium users).
*   **Polar.sh**: For secure payment processing.

These providers are contractually obligated to protect your data and operate under strict security standards.

## 5. Security

We implement industry-standard security measures:
*   **Encryption**: All data transmission (for Premium features) occurs over SSL/TLS encryption.
*   **Ephemeral Infrastructure**: Our processing servers are designed to be stateless regarding user content.

## 6. Your Rights

*   **Right to Delete**: Since your data lives in your browser, you have full control. You can delete all data by clicking "Clear Data" in the extension settings or by uninstalling the extension.
*   **No Cloud Account**: Because we don't maintain user accounts or store your photos long-term, there is no cloud account to delete.

## 7. Changes to This Policy

We may update this Privacy Policy. We will notify you of any changes by posting the new Privacy Policy on this page.

## 8. Contact Us

If you have questions about your privacy, contact us at:
**support@tallisa.dev**
