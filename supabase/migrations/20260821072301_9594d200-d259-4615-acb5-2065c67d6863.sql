REVOKE EXECUTE ON FUNCTION public.bump_image_asset_usage(uuid) FROM anon, authenticated;

DROP POLICY IF EXISTS "image_assets: any authenticated user can read" ON public.image_assets;
CREATE POLICY "image_assets: owner select"
ON public.image_assets FOR SELECT TO authenticated
USING (auth.uid() = created_by);

DROP POLICY IF EXISTS "project-assets read auth" ON storage.objects;
CREATE POLICY "project-assets owner select"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'project-assets' AND (storage.foldername(name))[1] = (auth.uid())::text);