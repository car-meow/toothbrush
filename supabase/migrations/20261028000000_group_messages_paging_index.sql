-- Support the group's newest-message and cursor-based history queries.
CREATE INDEX IF NOT EXISTS group_messages_group_created_id_idx
    ON public.group_messages (group_code, created_at DESC, id DESC);
