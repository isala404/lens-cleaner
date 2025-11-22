declare global {
	interface Window {
		umami: {
			track: (
				event: string | object | ((props: Record<string, unknown>) => Record<string, unknown>),
				data?: object
			) => void;
			identify: (data: object) => void;
		};
	}
}

export const trackEvent = (eventName: string, data?: Record<string, unknown>) => {
	try {
		if (typeof window !== 'undefined' && window.umami) {
			window.umami.track(eventName, data);
		} else {
			// console.debug('Analytics (Dev):', eventName, data);
		}
	} catch (e) {
		console.error('Analytics error:', e);
	}
};

export const trackScreen = (screenName: string) => {
	try {
		if (typeof window !== 'undefined' && window.umami) {
			// Track as a custom event for simplicity, or use virtual page tracking
			// virtual page tracking:
			// window.umami.track((props: any) => ({ ...props, url: `/screen/${screenName}`, title: screenName }));

			// But tracking as event is often clearer for SPAs in extension context where URL doesn't matter much
			window.umami.track('Screen View', { screen: screenName });
		}
	} catch (e) {
		console.error('Analytics error:', e);
	}
};

export const trackRevenue = (
	amount: number,
	currency: string = 'USD',
	data?: Record<string, unknown>
) => {
	try {
		if (typeof window !== 'undefined' && window.umami) {
			window.umami.track('revenue', {
				revenue: amount,
				currency,
				...data
			});
		}
	} catch (e) {
		console.error('Analytics error:', e);
	}
};
