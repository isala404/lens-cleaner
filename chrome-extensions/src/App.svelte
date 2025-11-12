<script lang="ts">
	import './app.css';
	import { onMount, onDestroy } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';

	import {
		appStore,
		filteredGroups,
		initializeApp,
		refreshData,
		calculateEmbeddings,
		groupPhotos,
		clearAllData,
		deleteFromGooglePhotos,
		togglePhotoSelection,
		selectAllInGroup,
		clearSelection,
		updateSettings
	} from './stores/appStore';

	import db, { type Group, type Photo } from './lib/db';
	import { uploadPhotos, startProcessing, getJobStatus, refundJob, verifyPayment } from './lib/api';
	import {
		preparePhotosForAutoSelect,
		pollJobStatus,
		retryJobStatus,
		applyAISuggestions
	} from './lib/autoSelect';

	// Components
	import Header from './components/Header.svelte';
	import ProgressSteps from './components/ProgressSteps.svelte';
	import WelcomeScreen from './components/WelcomeScreen.svelte';
	import PreviewScreen from './components/PreviewScreen.svelte';
	import IndexedScreen from './components/IndexedScreen.svelte';
	import ProcessingScreen from './components/ProcessingScreen.svelte';
	import ReviewScreen from './components/ReviewScreen.svelte';
	import SettingsModal from './components/SettingsModal.svelte';
	import RegroupWarningModal from './components/RegroupWarningModal.svelte';
	import ClearWarningModal from './components/ClearWarningModal.svelte';

	let currentStep: 'welcome' | 'preview' | 'indexing' | 'indexed' | 'grouping' | 'reviewing' =
		'welcome';

	let autoProcessing = false;
	let showSettings = false;
	let processingStartTime = 0;
	let processingStartProgress = 0; // Track progress at start for accurate time estimates
	let estimatedTimeRemaining = 0;

	// Auto-select state
	let autoSelectStatus:
		| 'idle'
		| 'payment'
		| 'ready'
		| 'uploading'
		| 'processing'
		| 'completed'
		| 'failed'
		| 'tampered' = 'idle';
	let autoSelectProgress = 0;
	let autoSelectError = '';
	let autoSelectJobId: string | null = null;
	let showRegroupWarning = false;
	let showClearWarning = false;
	let canRetryAutoSelect = false;
	let canRefundAutoSelect = false;
	let refundLoading = false;

	// Settings - reactive to appStore
	$: settings = {
		similarityThreshold: $appStore.settings.similarityThreshold,
		timeWindowMinutes: $appStore.settings.timeWindowMinutes,
		minGroupSize: $appStore.minGroupSize
	};

	// Save auto-select state to localStorage
	function saveAutoSelectState() {
		if (autoSelectJobId) {
			localStorage.setItem(
				'autoSelectState',
				JSON.stringify({
					jobId: autoSelectJobId,
					status: autoSelectStatus,
					error: autoSelectError,
					canRetry: canRetryAutoSelect,
					canRefund: canRefundAutoSelect,
					timestamp: Date.now()
				})
			);
		}
	}

	// Restore auto-select state from localStorage
	function restoreAutoSelectState() {
		try {
			const saved = localStorage.getItem('autoSelectState');
			if (saved) {
				const state = JSON.parse(saved);
				// Check if state is recent (within last 24 hours)
				const age = Date.now() - state.timestamp;
				if (age > 86400000) {
					// 24 hours
					localStorage.removeItem('autoSelectState');
					return null;
				}
				return state;
			}
		} catch {
			return null;
		}
		return null;
	}

	// Clear auto-select state
	function clearAutoSelectState() {
		localStorage.removeItem('autoSelectState');
		localStorage.removeItem('autoSelectJobId');
	}

	// Local settings for editing (before save)
	let editingSettings = {
		similarityThreshold: 0.406, // Default to 40.6% (70% in UI)
		timeWindowMinutes: 60,
		minGroupSize: 2
	};

	// Slider position for similarity threshold (0-100 in UI)
	// Maps to backend threshold (0.2-0.7)
	// UI 85% → Backend 45% (0.45)
	let similaritySliderPosition = 70; // Default to 70%

	// Convert backend threshold (0.2-0.7) to UI slider position (0-100)
	function thresholdToSliderPosition(threshold: number): number {
		// Map 0.2-0.45 to 0-85% slider position
		if (threshold <= 0.45) {
			return Math.round(((threshold - 0.2) / (0.45 - 0.2)) * 85);
		}

		// Map 0.45-0.7 to 85-100% slider position
		return Math.round(85 + ((threshold - 0.45) / (0.7 - 0.45)) * 15);
	}

	// Convert UI slider position (0-100) to backend threshold (0.2-0.7)
	function sliderPositionToThreshold(position: number): number {
		// Map 0-85% slider to 0.2-0.45 threshold
		if (position <= 85) {
			return 0.2 + (position / 85) * (0.45 - 0.2);
		}

		// Map 85-100% slider to 0.45-0.7 threshold
		return 0.45 + ((position - 85) / 15) * (0.7 - 0.45);
	}

	// Cache for group photos to avoid re-fetching
	let groupPhotosCache = new SvelteMap<string, Photo[]>();
	let ungroupedPhotos: Photo[] = [];

	onMount(async () => {
		await initializeApp();
		// Initialize editing settings from appStore
		editingSettings.similarityThreshold = $appStore.settings.similarityThreshold;
		editingSettings.timeWindowMinutes = $appStore.settings.timeWindowMinutes;
		editingSettings.minGroupSize = $appStore.minGroupSize;
		// Initialize slider position from threshold
		similaritySliderPosition = thresholdToSliderPosition(editingSettings.similarityThreshold);

		// Check if we need to resume interrupted processing
		if ($appStore.processingProgress.isProcessing) {
			if ($appStore.processingProgress.type === 'embedding') {
				currentStep = 'indexing';
				autoProcessing = true;
				processingStartTime = Date.now();
				processingStartProgress = $appStore.processingProgress.current; // Track where we're resuming from

				// Auto-resume embedding processing
				try {
					await calculateEmbeddings();
					await refreshData();
					determineCurrentStep();
				} catch (error) {
					console.error('Resume error:', error);
					autoProcessing = false;
					determineCurrentStep();
				}
			} else if ($appStore.processingProgress.type === 'grouping') {
				currentStep = 'grouping';
				autoProcessing = true;
				processingStartTime = Date.now();
				processingStartProgress = $appStore.processingProgress.current; // Track where we're resuming from

				// Auto-resume grouping
				try {
					await handleStartGrouping();
					determineCurrentStep();
				} catch (error) {
					console.error('Resume error:', error);
					autoProcessing = false;
					determineCurrentStep();
				}
			}
		} else {
			determineCurrentStep();
		}

		// Check for payment redirect from Polar (checkout_id in URL)
		const urlParams = new URLSearchParams(window.location.search);
		const checkoutId = urlParams.get('checkout_id');
		const paymentStatus = urlParams.get('payment');

		if (checkoutId && paymentStatus === 'success') {
			try {
				// Show verifying state while we contact Polar
				autoSelectStatus = 'payment';
				saveAutoSelectState();

				// Verify payment with Polar
				const verificationResponse = await verifyPayment(checkoutId);

				if (verificationResponse.payment_verified) {
					// Save job ID from verification response
					const jobId = verificationResponse.job_id;
					autoSelectJobId = jobId;
					localStorage.setItem('autoSelectJobId', jobId);
					await db.saveAutoSelectJob({
						jobId,
						status: 'created',
						email: '',
						photoCount: $appStore.stats.totalPhotos,
						createdAt: new Date().toISOString()
					});

					// Clear URL parameters
					window.history.replaceState({}, document.title, window.location.pathname);

					// Set status to ready - user must click button to start upload
					autoSelectStatus = 'ready';
					saveAutoSelectState();
				} else {
					// Payment not verified yet
					console.error('Payment not verified:', verificationResponse);
					autoSelectError = 'Payment verification pending. Please try again in a moment.';
					autoSelectStatus = 'failed';
					canRetryAutoSelect = true;
					saveAutoSelectState();

					// Clear URL parameters
					window.history.replaceState({}, document.title, window.location.pathname);
				}
			} catch (error) {
				console.error('Error verifying payment:', error);
				autoSelectError = error instanceof Error ? error.message : 'Failed to verify payment';
				autoSelectStatus = 'failed';
				canRetryAutoSelect = true;
				saveAutoSelectState();

				// Clear URL parameters
				window.history.replaceState({}, document.title, window.location.pathname);
			}
		} else {
			// Check if there's a saved auto-select state
			const savedState = restoreAutoSelectState();
			if (savedState) {
				autoSelectJobId = savedState.jobId;
				autoSelectStatus = savedState.status;
				autoSelectError = savedState.error;
				canRetryAutoSelect = savedState.canRetry;
				canRefundAutoSelect = savedState.canRefund;

				// Check job status if it's not a failed state
				if (autoSelectStatus !== 'failed') {
					await checkAutoSelectJobStatus(savedState.jobId);
				}
			} else {
				// Check for legacy saved job ID
				const savedJobId = localStorage.getItem('autoSelectJobId');
				if (savedJobId) {
					autoSelectJobId = savedJobId;
					// Check job status
					await checkAutoSelectJobStatus(savedJobId);
				}
			}
		}
	});

	function determineCurrentStep() {
		const stats = $appStore.stats;

		if (stats.totalPhotos === 0) {
			currentStep = 'welcome';
		} else if (stats.photosWithEmbeddings === 0) {
			currentStep = 'preview';
		} else if (stats.totalGroups === 0) {
			// All photos have embeddings but no groups yet - show indexed screen
			currentStep = 'indexed';
		} else {
			currentStep = 'reviewing';
			loadUngroupedPhotos();
		}
	}

	async function handleStartIndexing() {
		if (autoProcessing) return;
		autoProcessing = true;
		processingStartTime = Date.now();
		processingStartProgress = 0; // Start from 0 for new indexing
		currentStep = 'indexing';

		try {
			await calculateEmbeddings();
			await refreshData();
			determineCurrentStep();
		} catch (error) {
			console.error('Indexing error:', error);
			autoProcessing = false;
			determineCurrentStep();
		} finally {
			autoProcessing = false;
		}
	}

	async function handleStartGrouping() {
		if (!autoProcessing) {
			autoProcessing = true;
			processingStartTime = Date.now();
			processingStartProgress = 0; // Start from 0 for new grouping
		}

		currentStep = 'grouping';

		try {
			await groupPhotos();
			await refreshData();
			// Clear cache when new groups are created
			groupPhotosCache.clear();
			currentStep = 'reviewing';
			await loadUngroupedPhotos();
		} catch (error) {
			console.error('Grouping error:', error);
		} finally {
			autoProcessing = false;
		}
	}

	function handleClearSelection() {
		if ($appStore.selectedPhotosCount === 0) {
			return;
		}

		showClearWarning = true;
	}

	async function handleClearConfirmed() {
		showClearWarning = false;

		// Clear AI suggestions and auto-select state
		await db.clearAISuggestions();
		clearAutoSelectState();

		// Reset auto-select status to idle
		autoSelectStatus = 'idle';
		autoSelectProgress = 0;
		autoSelectError = '';
		autoSelectJobId = null;

		// Clear AI-related caches
		groupPhotosCache.clear();
		blobUrlCache.forEach((url) => URL.revokeObjectURL(url));
		blobUrlCache.clear();

		// Clear the selection
		clearSelection();
	}

	async function handleDeleteFromGooglePhotos() {
		if ($appStore.selectedPhotosCount === 0) {
			return;
		}

		if (
			confirm(
				`Create an album with ${$appStore.selectedPhotosCount} photo(s) in Google Photos for deletion?\n\nThis will:\n1. Open a new tab to Google Photos Albums\n2. Create an album with selected photos\n3. You can then review and delete them from the album`
			)
		) {
			try {
				await deleteFromGooglePhotos();
			} catch (error) {
				alert('Error initiating Google Photos deletion: ' + error);
			}
		}
	}

	async function handleReindex() {
		if (
			confirm(
				'This will clear all groups and embeddings. You will need to index again. Your scanned photos will be kept. Continue?'
			)
		) {
			try {
				// Clear groups and embeddings, keep photos
				await db.clearGroups();
				await db.clearEmbeddings();
				groupPhotosCache.clear();
				ungroupedPhotos = [];
				await refreshData();
				currentStep = 'preview';
			} catch (error) {
				alert('Error reindexing: ' + error);
			}
		}
	}

	// Auto-select handlers
	function handleAutoSelect() {
		// Just open modal, handled in ReviewScreen
	}

	async function handleCheckoutCreated(checkoutUrl: string, checkoutId: string, jobId: string) {
		// Store job ID for when payment completes
		// Note: PaymentModal will handle navigation to Polar checkout page
		autoSelectJobId = jobId;
		localStorage.setItem('autoSelectJobId', jobId);
		localStorage.setItem('autoSelectCheckoutId', checkoutId);
	}

	async function handleAutoSelectUpload() {
		try {
			autoSelectStatus = 'uploading';
			autoSelectProgress = 0;
			saveAutoSelectState();

			// Get all photos with embeddings
			const photos = await db.getAllPhotos();
			const photosWithEmbeddings = photos.filter((p) => p.hasEmbedding);

			if (photosWithEmbeddings.length === 0) {
				throw new Error('No photos to upload');
			}

			if (!autoSelectJobId) {
				throw new Error('No job ID found');
			}

			// Prepare photos (convert blobs to files)
			const { files, photoMetadata } = await preparePhotosForAutoSelect(photosWithEmbeddings);

			// Upload files with atomic requests (5 concurrent)
			await uploadPhotos(autoSelectJobId, files, (uploaded, total) => {
				// Map upload progress to 0-80% range
				autoSelectProgress = Math.round((uploaded / total) * 80);
			});

			autoSelectProgress = 85;

			// Start processing
			await startProcessing(autoSelectJobId, photoMetadata);
			autoSelectProgress = 100;

			// Start polling
			autoSelectStatus = 'processing';
			saveAutoSelectState();
			await pollJobStatus(
				autoSelectJobId,
				(status) => {
					console.log('Job status:', status);
				},
				async (results) => {
					// Apply AI suggestions
					await applyAISuggestions(results.deletions);

					// Select photos with AI suggestions
					const photosToSelect = results.deletions.map((d) => d.photo_id);
					photosToSelect.forEach((id) => togglePhotoSelection(id));

					autoSelectStatus = 'completed';
					localStorage.removeItem('autoSelectJobId');
					await refreshData();
					// Full page restart after successful AI auto selection
					location.reload();
				},
				(error, canRetry) => {
					autoSelectStatus = 'failed';
					autoSelectError = error;
					canRetryAutoSelect = canRetry;
					canRefundAutoSelect = canRetry; // Allow refund if retry is available
					saveAutoSelectState();
				}
			);
		} catch (error) {
			autoSelectStatus = 'failed';
			autoSelectError = error instanceof Error ? error.message : 'Upload failed';
			saveAutoSelectState();
		}
	}

	async function checkAutoSelectJobStatus(jobId: string) {
		try {
			const response = await getJobStatus(jobId);

			if (response.status === 'processing') {
				autoSelectStatus = 'processing';
				saveAutoSelectState();
				// Start polling
				await pollJobStatus(
					jobId,
					(status) => {
						console.log('Job status:', status);
					},
					async (results) => {
						await applyAISuggestions(results.deletions);

						const photosToSelect = results.deletions.map((d) => d.photo_id);
						photosToSelect.forEach((id) => togglePhotoSelection(id));

						autoSelectStatus = 'completed';
						clearAutoSelectState();
						await refreshData();
						// Full page restart after successful AI auto selection
						location.reload();
					},
					(error, canRetry) => {
						autoSelectStatus = 'failed';
						autoSelectError = error;
						canRetryAutoSelect = canRetry;
						canRefundAutoSelect = canRetry; // Allow refund if retry is available
						saveAutoSelectState();
					}
				);
			} else if (response.status === 'completed' && response.results) {
				await applyAISuggestions(response.results.deletions);

				const photosToSelect = response.results.deletions.map((d) => d.photo_id);
				photosToSelect.forEach((id) => togglePhotoSelection(id));

				autoSelectStatus = 'completed';
				clearAutoSelectState();
				await refreshData();
				// Full page restart after successful AI auto selection
				location.reload();
			} else if (response.status === 'tampered') {
				autoSelectStatus = 'failed';
				autoSelectError = `Payment amount was modified during checkout. Please contact support@tallisa.dev for assistance. Expected: $${(response.expected_amount || 0) / 100}, Actual: $${(response.actual_amount || 0) / 100}`;
				canRetryAutoSelect = false;
				canRefundAutoSelect = false;
				saveAutoSelectState();
			} else if (response.status === 'failed') {
				autoSelectStatus = 'failed';
				autoSelectError = 'Processing failed';
				canRetryAutoSelect = true;
				canRefundAutoSelect = true;
				saveAutoSelectState();
			}
		} catch (error) {
			console.error('Error checking job status:', error);
			// If we get an error checking status, set failed state with retry option
			autoSelectStatus = 'failed';
			autoSelectError = error instanceof Error ? error.message : 'Failed to check job status';
			canRetryAutoSelect = true;
			canRefundAutoSelect = true;
			saveAutoSelectState();
		}
	}

	async function handleRetryAutoSelect() {
		if (!autoSelectJobId) return;

		try {
			autoSelectStatus = 'processing';
			canRetryAutoSelect = false;
			canRefundAutoSelect = false;
			saveAutoSelectState();

			// Get photos and recreate photoMetadata for retry
			const photos = await db.getAllPhotos();
			const photosWithEmbeddings = photos.filter((p) => p.hasEmbedding);
			const { photoMetadata } = await preparePhotosForAutoSelect(photosWithEmbeddings);

			await retryJobStatus(
				autoSelectJobId,
				photoMetadata,
				(status) => {
					console.log('Job status:', status);
				},
				async (results) => {
					await applyAISuggestions(results.deletions);

					const photosToSelect = results.deletions.map((d) => d.photo_id);
					photosToSelect.forEach((id) => togglePhotoSelection(id));

					autoSelectStatus = 'completed';
					clearAutoSelectState();
					await refreshData();
				},
				(error, canRetry) => {
					autoSelectStatus = 'failed';
					autoSelectError = error;
					canRetryAutoSelect = canRetry;
					canRefundAutoSelect = canRetry;
					saveAutoSelectState();
				}
			);
		} catch (error) {
			autoSelectStatus = 'failed';
			autoSelectError = error instanceof Error ? error.message : 'Retry failed';
			canRetryAutoSelect = true;
			canRefundAutoSelect = true;
			saveAutoSelectState();
		}
	}

	async function handleRefundAutoSelect() {
		if (!autoSelectJobId) return;

		try {
			refundLoading = true;
			const refundResponse = await refundJob(autoSelectJobId);

			if (refundResponse.success) {
				autoSelectStatus = 'idle';
				autoSelectError = '';
				canRetryAutoSelect = false;
				canRefundAutoSelect = false;
				clearAutoSelectState();
				autoSelectJobId = null;
				alert(`Refund processed successfully! ${refundResponse.message}`);
			} else {
				autoSelectError = refundResponse.message;
				saveAutoSelectState();
			}
		} catch (error) {
			autoSelectError = error instanceof Error ? error.message : 'Refund failed';
			saveAutoSelectState();
		} finally {
			refundLoading = false;
		}
	}

	async function handleRegroup() {
		// Check if there are AI suggestions
		const photos = await db.getAllPhotos();
		const photosWithAI = photos.filter((p) => p.aiSuggestionReason);

		if (photosWithAI.length > 0) {
			// Show warning modal
			showRegroupWarning = true;
			return;
		}

		if (
			confirm(
				'This will clear all duplicate groups. You can adjust settings and regroup. Your indexed photos will be kept. Continue?'
			)
		) {
			await performRegroup();
		}
	}

	async function performRegroup() {
		try {
			// Clear AI suggestions and auto-select state
			await db.clearAISuggestions();
			localStorage.removeItem('autoSelectJobId');
			autoSelectJobId = null;
			autoSelectStatus = 'idle';

			// Clear AI-related caches
			groupPhotosCache.clear();
			blobUrlCache.forEach((url) => URL.revokeObjectURL(url));
			blobUrlCache.clear();

			// Only clear groups, keep embeddings
			await db.clearGroups();
			ungroupedPhotos = [];
			await refreshData();
			currentStep = 'indexed';
		} catch (error) {
			alert('Error regrouping: ' + error);
		}
	}

	async function handleRegroupConfirmed() {
		showRegroupWarning = false;
		await performRegroup();
	}

	async function handleRescan() {
		if (
			confirm(
				'⚠️ WARNING: This will delete all scanned photos and groups. You will need to scan from Google Photos again. Continue?'
			)
		) {
			try {
				await clearAllData();
				groupPhotosCache.clear();
				ungroupedPhotos = [];
				await refreshData();
				currentStep = 'welcome';
			} catch (error) {
				alert('Error clearing data: ' + error);
			}
		}
	}

	async function handleSaveSettings() {
		await updateSettings({
			similarityThreshold: editingSettings.similarityThreshold,
			timeWindowMinutes: editingSettings.timeWindowMinutes
		});

		// Update minGroupSize separately as it's not part of Settings interface
		appStore.update((s) => ({
			...s,
			minGroupSize: editingSettings.minGroupSize
		}));

		showSettings = false;
	}

	function handleOpenSettings() {
		// Load current settings into editing settings when opening modal
		editingSettings.similarityThreshold = $appStore.settings.similarityThreshold;
		editingSettings.timeWindowMinutes = $appStore.settings.timeWindowMinutes;
		editingSettings.minGroupSize = $appStore.minGroupSize;
		// Initialize slider position from threshold
		similaritySliderPosition = thresholdToSliderPosition(editingSettings.similarityThreshold);
		showSettings = true;
	}

	// Update threshold when slider position changes
	$: if (showSettings) {
		editingSettings.similarityThreshold = sliderPositionToThreshold(similaritySliderPosition);
	}

	async function getGroupPhotos(group: Group): Promise<Photo[]> {
		// Check cache first
		if (groupPhotosCache.has(group.id)) {
			return groupPhotosCache.get(group.id)!;
		}

		// Get photos in the order specified by group.photoIds
		// Note: We intentionally avoid client-side sorting for large datasets (1M+ photos)
		// The database returns photos already sorted; we just fetch them in their order
		const photos = await Promise.all(group.photoIds.map((id) => db.getPhoto(id)));
		const validPhotos = photos.filter((p) => p !== undefined) as Photo[];

		// Cache the result
		groupPhotosCache.set(group.id, validPhotos);
		return validPhotos;
	}

	async function loadUngroupedPhotos() {
		try {
			const allPhotos = await db.getAllPhotos();
			const allGroups = await db.getAllGroups();
			// Get all photo IDs that are in groups
			const groupedPhotoIds = new SvelteSet<string>();

			allGroups.forEach((group) => {
				group.photoIds.forEach((id) => groupedPhotoIds.add(id));
			});

			// Filter photos that are NOT in any group
			ungroupedPhotos = allPhotos.filter((photo) => !groupedPhotoIds.has(photo.id));
		} catch (error) {
			console.error('Error loading ungrouped photos:', error);
			ungroupedPhotos = [];
		}
	}

	// Update time estimate
	$: if ($appStore.processingProgress.isProcessing && processingStartTime > 0) {
		const elapsed = Date.now() - processingStartTime;
		const current = $appStore.processingProgress.current;
		const total = $appStore.processingProgress.total;
		const progressMade = current - processingStartProgress; // Only count new progress

		// Only calculate estimate if we've made progress since starting/resuming
		if (progressMade > 0 && total > 0 && elapsed > 0) {
			const rate = progressMade / elapsed; // items per ms (based on new progress only)
			const remaining = total - current;

			estimatedTimeRemaining = remaining / rate; // ms
		} else {
			estimatedTimeRemaining = 0; // Don't show estimate until we have progress
		}
	}

	function formatTimeEstimate(ms: number): string {
		const totalSeconds = Math.ceil(ms / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;

		if (minutes === 0) {
			return `${seconds} seconds`;
		} else if (minutes < 60) {
			return `${minutes} minute${minutes !== 1 ? 's' : ''} ${seconds} second${seconds !== 1 ? 's' : ''}`;
		} else {
			const hours = Math.floor(minutes / 60);
			const remainingMinutes = minutes % 60;

			return `${hours} hour${hours !== 1 ? 's' : ''} ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
		}
	}

	// Filter groups by minimum size
	$: displayGroups = $filteredGroups.filter((g) => g.photoIds.length >= settings.minGroupSize);

	// Track blob URLs for cleanup
	let blobUrlCache = new SvelteMap<string, string>();

	function getCachedBlobUrl(photo: Photo): string {
		if (blobUrlCache.has(photo.id)) {
			return blobUrlCache.get(photo.id)!;
		}
		const url = URL.createObjectURL(photo.blob);
		blobUrlCache.set(photo.id, url);
		return url;
	}

	// Cleanup blob URLs when component is destroyed
	onDestroy(() => {
		blobUrlCache.forEach((url) => URL.revokeObjectURL(url));
		blobUrlCache.clear();
	});
</script>

<div class="mx-auto max-w-7xl px-5 py-8">
	<!-- Header -->
	<Header />

	<!-- Progress Steps -->
	<ProgressSteps {currentStep} />

	<!-- Main Content -->
	<main class="cozy-card shadow-brutalist-lg min-h-[400px] p-12">
		{#if currentStep === 'welcome'}
			<WelcomeScreen />
		{:else if currentStep === 'preview'}
			<PreviewScreen
				totalPhotos={$appStore.stats.totalPhotos}
				photos={$appStore.photos}
				onStartIndexing={handleStartIndexing}
				{getCachedBlobUrl}
			/>
		{:else if currentStep === 'indexed'}
			<IndexedScreen
				photosWithEmbeddings={$appStore.stats.photosWithEmbeddings}
				photos={$appStore.photos}
				onStartGrouping={handleStartGrouping}
				onReindex={handleReindex}
				onOpenSettings={handleOpenSettings}
				{getCachedBlobUrl}
			/>
		{:else if currentStep === 'indexing' || currentStep === 'grouping'}
			<ProcessingScreen
				{currentStep}
				totalPhotos={$appStore.stats.totalPhotos}
				photosWithEmbeddings={$appStore.stats.photosWithEmbeddings}
				totalGroups={$appStore.stats.totalGroups}
				processingProgress={$appStore.processingProgress}
				{estimatedTimeRemaining}
				{formatTimeEstimate}
			/>
		{:else if currentStep === 'reviewing'}
			<ReviewScreen
				{displayGroups}
				{ungroupedPhotos}
				selectedCount={$appStore.selectedPhotosCount}
				onToggleSelection={togglePhotoSelection}
				onSelectAllInGroup={selectAllInGroup}
				onClearSelection={handleClearSelection}
				onDeleteFromGooglePhotos={handleDeleteFromGooglePhotos}
				onRegroup={handleRegroup}
				onReindex={handleReindex}
				onRescan={handleRescan}
				{getCachedBlobUrl}
				{getGroupPhotos}
				{autoSelectStatus}
				{autoSelectProgress}
				{autoSelectError}
				onAutoSelect={handleAutoSelect}
				onCheckoutCreated={handleCheckoutCreated}
				onStartUpload={handleAutoSelectUpload}
				totalPhotosCount={$appStore.stats.photosWithEmbeddings}
				{canRetryAutoSelect}
				{canRefundAutoSelect}
				onRetryAutoSelect={handleRetryAutoSelect}
				onRefundAutoSelect={handleRefundAutoSelect}
				{refundLoading}
				enableGroupPagination={true}
				totalGroupsCount={$appStore.stats.totalGroups}
			/>
		{/if}
	</main>
</div>

<!-- Settings Modal -->
<SettingsModal
	{showSettings}
	{editingSettings}
	{similaritySliderPosition}
	onClose={() => (showSettings = false)}
	onSave={handleSaveSettings}
	onSliderChange={(value) => {
		similaritySliderPosition = value;
		editingSettings.similarityThreshold = sliderPositionToThreshold(value);
	}}
/>

<!-- Regroup Warning Modal -->
<RegroupWarningModal
	show={showRegroupWarning}
	onClose={() => (showRegroupWarning = false)}
	onConfirm={handleRegroupConfirmed}
/>

<!-- Clear Warning Modal -->
<ClearWarningModal
	show={showClearWarning}
	selectedCount={$appStore.selectedPhotosCount}
	onClose={() => (showClearWarning = false)}
	onConfirm={handleClearConfirmed}
/>

<style>
	/* Responsive adjustments */
	@media (max-width: 768px) {
		.cozy-card {
			padding: 24px !important;
		}
	}
</style>
