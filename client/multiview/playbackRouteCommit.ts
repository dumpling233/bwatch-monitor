/** Signed route results may commit only to the same mounted room and authorization. */
export class PlaybackRouteCommitGuard {
  private identity = '';
  private rooms = new Map<string, { source: 'custom' }>();

  update(identity: string, selected: readonly string[], rooms: ReadonlyMap<string, { source?: 'custom' }>): void {
    const previous = identity === this.identity ? this.rooms : new Map<string, { source: 'custom' }>();
    this.identity = identity;
    this.rooms = new Map(selected.flatMap(id => {
      const room = rooms.get(id);
      if (!room) return [];
      const source = room.source ?? 'custom', old = previous.get(id);
      return [[id, old?.source === source ? old : { source }] as const];
    }));
  }

  capture(roomId: string, source: 'custom'): () => boolean {
    const generation = this.rooms.get(roomId);
    return () => Boolean(generation && generation.source === source && this.rooms.get(roomId) === generation);
  }
}
