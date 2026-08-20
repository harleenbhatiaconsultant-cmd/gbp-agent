/**
 * Liveness/readiness endpoint.
 *
 * Thin by design: it validates nothing, decides nothing, and delegates to a
 * service. Railway health checks and local smoke tests both hit this.
 */

import { NextResponse } from 'next/server';
import { getHealthReport } from '@/server/services/health';
import { toClientError } from '@/server/errors';
import { logger } from '@/server/observability/logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const report = await getHealthReport();
    return NextResponse.json(report, {
      status: report.status === 'error' ? 503 : 200,
    });
  } catch (error) {
    logger.error({ err: error }, 'Health endpoint failed');
    const clientError = toClientError(error);
    return NextResponse.json(
      { status: 'error', code: clientError.code, message: clientError.message },
      { status: clientError.httpStatus },
    );
  }
}
