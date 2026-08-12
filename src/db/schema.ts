/**
 * Legacy schema entry point - re-exports everything from the split modules.
 * New code should import directly from '@/db/schema' (which resolves here)
 * or from individual modules in '@/db/schema/'.
 */
export * from './schema/index';
