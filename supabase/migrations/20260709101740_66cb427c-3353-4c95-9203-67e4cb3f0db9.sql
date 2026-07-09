
create policy "project-assets read auth" on storage.objects for select to authenticated using (bucket_id = 'project-assets');
create policy "project-assets owner insert" on storage.objects for insert to authenticated with check (bucket_id = 'project-assets' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "project-assets owner update" on storage.objects for update to authenticated using (bucket_id = 'project-assets' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "project-assets owner delete" on storage.objects for delete to authenticated using (bucket_id = 'project-assets' and (storage.foldername(name))[1] = auth.uid()::text);
