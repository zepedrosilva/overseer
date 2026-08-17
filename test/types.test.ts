import { describe, it, expect } from 'vitest';
import {
  prKeyToString,
  parsePrKey,
  parseRepoUrl,
  type PrKey,
} from '../src/app/types.js';

describe('Domain Types Helpers', () => {
  describe('prKeyToString', () => {
    it('formats PrKey as owner/repo#number', () => {
      const key: PrKey = { owner: 'MewsSystems', repo: 'billing', number: 142 };
      expect(prKeyToString(key)).toBe('MewsSystems/billing#142');
    });
  });

  describe('parsePrKey', () => {
    it('parses owner/repo#number', () => {
      expect(parsePrKey('MewsSystems/billing#142')).toEqual({
        owner: 'MewsSystems',
        repo: 'billing',
        number: 142,
      });
    });

    it('parses owner/repo/pull/number', () => {
      expect(parsePrKey('owner/repo/pull/42')).toEqual({
        owner: 'owner',
        repo: 'repo',
        number: 42,
      });
    });

    it('returns null for invalid string', () => {
      expect(parsePrKey('invalid-key')).toBeNull();
      expect(parsePrKey('')).toBeNull();
      expect(parsePrKey('owner/repo')).toBeNull();
    });
  });

  describe('parseRepoUrl', () => {
    it('parses SSH git URLs', () => {
      expect(parseRepoUrl('git@github.com:MewsSystems/billing.git')).toEqual({
        owner: 'MewsSystems',
        repo: 'billing',
      });
      expect(parseRepoUrl('git@github.com:zepedrosilva/overseer.git')).toEqual({
        owner: 'zepedrosilva',
        repo: 'overseer',
      });
    });

    it('parses HTTPS git URLs', () => {
      expect(parseRepoUrl('https://github.com/MewsSystems/billing.git')).toEqual({
        owner: 'MewsSystems',
        repo: 'billing',
      });
      expect(parseRepoUrl('https://github.com/owner/repo')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
      expect(parseRepoUrl('https://github.com/owner/repo/pulls')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
    });

    it('parses shorthand owner/repo notation', () => {
      expect(parseRepoUrl('MewsSystems/billing')).toEqual({
        owner: 'MewsSystems',
        repo: 'billing',
      });
    });

    it('returns null for invalid URLs', () => {
      expect(parseRepoUrl('https://gitlab.com/owner/repo')).toBeNull();
      expect(parseRepoUrl('invalid-url')).toBeNull();
      expect(parseRepoUrl('')).toBeNull();
    });
  });
});
