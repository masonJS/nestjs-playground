describe('CustomExpect', () => {
  describe('beBetween', () => {
    it('min과 max 범위안의 값이 아니면 에러가 발생한다.', () => {
      // given, when
      try {
        expect(10).toBeBetween(0, 9);
      } catch (e) {
        // then
        expect(e.message).toBe('expected 10 to be within range (0..9)');
      }
    });

    it('not chain을 사용할때 min과 max 범위안의 값이면 에러가 발생한다.', () => {
      // given, when
      try {
        expect(10).not.toBeBetween(0, 10);
      } catch (e) {
        // then
        expect(e.message).toBe('expected 10 not to be within range (0..10)');
      }
    });

    it('min과 max 사이의 값인지 확인한다.', () => {
      expect(10).toBeBetween(0, 10);
    });
  });

  describe('toBeTrue', () => {
    it('true 값이 아니면 에러가 발생한다.', function () {
      try {
        expect('true' as any).toBeTrue();
      } catch (e) {
        expect(e.message).toBe('expected true to be true');
      }
    });

    it('true 값인지 확인한다.', function () {
      expect(true).toBeTrue();
    });
  });

  describe('toBeEmpty', () => {
    it('빈배열이 아니면 에러가 발생한다.', function () {
      try {
        expect([1]).toBeEmpty();
      } catch (e) {
        expect(e.message).toBe('expected [1] to be empty');
      }
    });

    it('빈 배열인지 확인한다.', () => {
      expect([]).toBeEmpty();
    });
  });
});
