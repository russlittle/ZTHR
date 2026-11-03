/**
 * The Advocate's store is the store block's DocStore (ADR 0001): each document is owned by one student, so
 * export and deletion are a single query each.
 */
export { DocStore as AppStore } from '@zthr/store';
