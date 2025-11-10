/**
 * Backend API Client for Lens Cleaner auto-select feature
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080/api/v1';

export interface CostCalculationResponse {
  photo_count: number;
  total_cost: number;
  currency: string;
  price_per_photo: number;
}

export interface PaymentResponse {
  payment_id: string;
  status: string;
}

export interface JobResponse {
  job_id: string;
  status: string;
}

export interface JobStatusResponse {
  id: string;
  status: string;
  total_photos: number;
  uploaded_photos: number;
  processed_photos: number;
  progress: number;
  error_message?: string;
  completed_at?: string;
  estimated_time?: number;
}

export interface ProcessingResult {
  id: string;
  photo_id: string;
  group_id: string;
  should_delete: boolean;
  reason?: string;
  confidence: string;
}

export interface ResultsResponse {
  job_id: string;
  results: ProcessingResult[];
}

export interface RefundTemplateResponse {
  subject: string;
  body: string;
  to: string;
  unused_photos: number;
  refund_amount: number;
}

class APIClient {
  private baseURL: string;

  constructor(baseURL: string = API_BASE_URL) {
    this.baseURL = baseURL;
  }

  /**
   * Calculate cost for processing photos
   */
  async calculateCost(photoCount: number): Promise<CostCalculationResponse> {
    const response = await fetch(`${this.baseURL}/cost/calculate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ photo_count: photoCount }),
    });

    if (!response.ok) {
      throw new Error(`Cost calculation failed: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Create payment record after successful payment
   */
  async createPayment(
    userId: string,
    photoCount: number,
    amountPaid: number,
    paymentId: string,
    paymentProvider: string = 'polar'
  ): Promise<PaymentResponse> {
    const response = await fetch(`${this.baseURL}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: userId,
        photo_count: photoCount,
        amount_paid: amountPaid,
        payment_id: paymentId,
        payment_provider: paymentProvider,
      }),
    });

    if (!response.ok) {
      throw new Error(`Payment creation failed: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Create a new processing job
   */
  async createJob(paymentId: string, userId: string, photoCount: number): Promise<JobResponse> {
    const response = await fetch(`${this.baseURL}/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payment_id: paymentId,
        user_id: userId,
        photo_count: photoCount,
      }),
    });

    if (!response.ok) {
      throw new Error(`Job creation failed: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Upload a photo to a job
   */
  async uploadPhoto(jobId: string, photoId: string, photoBlob: Blob): Promise<{ photo_id: string; status: string; uploaded_count: number; total_count: number }> {
    const formData = new FormData();
    formData.append('photo_id', photoId);
    formData.append('photo', photoBlob, `${photoId}.jpg`);

    const response = await fetch(`${this.baseURL}/jobs/${jobId}/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Photo upload failed: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Submit grouping data
   */
  async submitGrouping(jobId: string, groups: Record<string, string[]>): Promise<{ job_id: string; status: string; message: string }> {
    const response = await fetch(`${this.baseURL}/grouping/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        job_id: jobId,
        grouping_data: { groups },
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `Grouping submission failed: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get job status
   */
  async getJobStatus(jobId: string): Promise<JobStatusResponse> {
    const response = await fetch(`${this.baseURL}/jobs/${jobId}/status`);

    if (!response.ok) {
      throw new Error(`Failed to get job status: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get processing results
   */
  async getResults(jobId: string): Promise<ResultsResponse> {
    const response = await fetch(`${this.baseURL}/jobs/${jobId}/results`);

    if (!response.ok) {
      throw new Error(`Failed to get results: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get refund email template
   */
  async getRefundTemplate(jobId: string, email: string): Promise<RefundTemplateResponse> {
    const response = await fetch(`${this.baseURL}/refund/template?job_id=${jobId}&email=${email}`);

    if (!response.ok) {
      throw new Error(`Failed to get refund template: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Health check
   */
  async health(): Promise<{ status: string; time: string }> {
    const response = await fetch(`${this.baseURL}/health`);

    if (!response.ok) {
      throw new Error(`Health check failed: ${response.statusText}`);
    }

    return response.json();
  }
}

export const apiClient = new APIClient();
